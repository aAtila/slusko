"""A/B harness comparing summarization system prompts via real OpenRouter calls.

For each (prompt variant × transcript × attempt) it:
  1. Monkey-patches `slusko_worker.pipeline.summarization._system_prompt`
     so the live `OpenRouterSummarizer.summarize()` codepath uses the
     candidate prompt verbatim.
  2. Calls OpenRouter (real API).
  3. Runs the assertion suite from `grade.py`.
  4. Records the draft, latency, error (if any), and assertion outcomes.

Outputs to `worker/evals/summarization_prompt_ab/results/<UTC-timestamp>/`:
  - runs.jsonl   — one row per call
  - report.md    — pass-rate summary + per-fixture / per-prompt detail
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import sys
import time
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID

from slusko_worker.db.models import (
    MeetingStatus,
    QueuedMeeting,
    SummaryDraft,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline import summarization as live
from slusko_worker.pipeline.errors import SummarizationFailed

from . import grade as grading
from .prompts import PROMPT_VARIANTS


HERE = Path(__file__).resolve().parent
TRANSCRIPTS_DIR = HERE / "transcripts"
RESULTS_ROOT = HERE / "results"
LOGGER = logging.getLogger("summarization_ab")


def _load_transcripts() -> list[dict[str, Any]]:
    fixtures = []
    for path in sorted(TRANSCRIPTS_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as f:
            fixtures.append(json.load(f))
    if not fixtures:
        raise SystemExit(f"No transcript fixtures found in {TRANSCRIPTS_DIR}")
    return fixtures


def _to_segments(fixture: dict[str, Any]) -> tuple[TranscriptSegmentDraft, ...]:
    return tuple(
        TranscriptSegmentDraft(
            start_seconds=float(s["start_seconds"]),
            end_seconds=float(s["end_seconds"]),
            speaker_label=str(s["speaker_label"]),
            text=str(s["text"]),
        )
        for s in fixture["segments"]
    )


def _meeting_for(fixture: dict[str, Any], attempt: int) -> QueuedMeeting:
    # Deterministic synthetic UUID per (fixture, attempt) so collisions can't
    # happen across reruns or across variants in the same run.
    seed = f"{fixture['id']}:{attempt}".encode()
    fake = (b"\x00" * 16 + seed)[-16:]
    return QueuedMeeting(
        id=UUID(bytes=fake),
        status=MeetingStatus.SUMMARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


def _draft_to_jsonable(draft: SummaryDraft) -> dict[str, Any]:
    return {
        "overview": draft.overview,
        "decisions": [{"text": d.text} for d in draft.decisions],
        "actionItems": [
            {
                "task": a.task,
                "owner": {
                    "kind": a.owner.kind,
                    "value": a.owner.value,
                },
            }
            for a in draft.action_items
        ],
        "openQuestions": [{"text": q.text} for q in draft.open_questions],
    }


def _assertions_to_jsonable(asserts: Iterable[grading.Assertion]) -> list[dict[str, Any]]:
    return [dataclasses.asdict(a) for a in asserts]


def _run_one(
    *,
    prompt_variant: str,
    prompt_text: str,
    fixture: dict[str, Any],
    attempt: int,
    api_key: str,
    model: str,
    base_url: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    summarizer = live.OpenRouterSummarizer(
        api_key=api_key,
        model=model,
        base_url=base_url,
        timeout_seconds=timeout_seconds,
    )
    meeting = _meeting_for(fixture, attempt)
    segments = _to_segments(fixture)

    started = time.monotonic()
    error: str | None = None
    draft: SummaryDraft | None = None
    try:
        with patch.object(live, "_system_prompt", lambda: prompt_text):
            draft = summarizer.summarize(meeting=meeting, transcript_segments=segments)
    except SummarizationFailed as err:
        error = f"SummarizationFailed: {err}"
    except Exception as err:  # noqa: BLE001 — eval harness, surface anything
        error = f"{type(err).__name__}: {err}"
    latency_seconds = time.monotonic() - started

    asserts: list[grading.Assertion] = (
        grading.grade(draft, fixture) if draft is not None else []
    )
    pass_count = sum(1 for a in asserts if a.passed)

    return {
        "prompt_variant": prompt_variant,
        "fixture_id": fixture["id"],
        "attempt": attempt,
        "model": model,
        "latency_seconds": round(latency_seconds, 3),
        "error": error,
        "draft": _draft_to_jsonable(draft) if draft is not None else None,
        "assertions": _assertions_to_jsonable(asserts),
        "passed_count": pass_count,
        "total_count": len(asserts),
    }


def _write_report(results_dir: Path, runs: list[dict[str, Any]], *, models: list[str]) -> Path:
    report_lines: list[str] = []
    report_lines.append("# Summarization Prompt A/B Report")
    report_lines.append("")
    report_lines.append(f"- Models: " + ", ".join(f"`{m}`" for m in models))
    report_lines.append(f"- Runs: {len(runs)}")
    report_lines.append(f"- Generated: {datetime.now(timezone.utc).isoformat()}")
    report_lines.append("")

    variants = sorted({r["prompt_variant"] for r in runs})
    fixtures = sorted({r["fixture_id"] for r in runs})
    models_in_runs = sorted({r["model"] for r in runs})

    # ---------- Headline: pass rate per (model × prompt) ----------
    report_lines.append("## Headline pass-rate per (model × prompt)")
    report_lines.append("")
    report_lines.append("| Model | Prompt | Runs | Errors | Assertion pass rate |")
    report_lines.append("|---|---|---|---|---|")
    for m in models_in_runs:
        for v in variants:
            cell_runs = [r for r in runs if r["model"] == m and r["prompt_variant"] == v]
            errors = sum(1 for r in cell_runs if r["error"])
            passed = sum(r["passed_count"] for r in cell_runs)
            total = sum(r["total_count"] for r in cell_runs)
            rate = f"{passed}/{total} ({100 * passed / total:.0f}%)" if total else "n/a"
            report_lines.append(f"| `{m}` | `{v}` | {len(cell_runs)} | {errors} | {rate} |")
    report_lines.append("")

    # ---------- Per-model: fixture × prompt breakdown ----------
    for m in models_in_runs:
        report_lines.append(f"## Pass rate per (fixture × prompt) — `{m}`")
        report_lines.append("")
        header = "| Fixture | " + " | ".join(f"`{v}`" for v in variants) + " |"
        sep = "|---|" + "---|" * len(variants)
        report_lines.append(header)
        report_lines.append(sep)
        for f in fixtures:
            cells = [f"`{f}`"]
            for v in variants:
                cell_runs = [
                    r for r in runs
                    if r["model"] == m and r["prompt_variant"] == v and r["fixture_id"] == f
                ]
                passed = sum(r["passed_count"] for r in cell_runs)
                total = sum(r["total_count"] for r in cell_runs)
                errors = sum(1 for r in cell_runs if r["error"])
                txt = (
                    f"{passed}/{total}" + (f" ⚠️{errors}err" if errors else "")
                    if total
                    else "n/a"
                )
                cells.append(txt)
            report_lines.append("| " + " | ".join(cells) + " |")
        report_lines.append("")

    # ---------- Failed assertions ----------
    report_lines.append("## Failed assertions (any model, any prompt, any run)")
    report_lines.append("")
    failures_found = False
    for r in runs:
        for a in r["assertions"]:
            if not a["passed"]:
                failures_found = True
                report_lines.append(
                    f"- `{r['model']}` · `{r['prompt_variant']}` · `{r['fixture_id']}` · attempt {r['attempt']} · "
                    f"**{a['id']}** — {a['evidence']}"
                )
        if r["error"]:
            failures_found = True
            report_lines.append(
                f"- `{r['model']}` · `{r['prompt_variant']}` · `{r['fixture_id']}` · attempt {r['attempt']} · "
                f"**ERROR** — {r['error']}"
            )
    if not failures_found:
        report_lines.append("(none — every assertion passed everywhere)")
    report_lines.append("")

    # ---------- Sample drafts ----------
    report_lines.append("## Sample drafts (one per model × fixture × variant)")
    report_lines.append("")
    seen: set[tuple[str, str, str]] = set()
    for r in runs:
        key = (r["model"], r["prompt_variant"], r["fixture_id"])
        if key in seen or r["draft"] is None:
            continue
        seen.add(key)
        report_lines.append(
            f"### `{r['fixture_id']}` — `{r['model']}` × `{r['prompt_variant']}` (attempt {r['attempt']})"
        )
        report_lines.append("")
        report_lines.append("```json")
        report_lines.append(json.dumps(r["draft"], ensure_ascii=False, indent=2))
        report_lines.append("```")
        report_lines.append("")

    report_path = results_dir / "report.md"
    report_path.write_text("\n".join(report_lines), encoding="utf-8")
    return report_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runs",
        type=int,
        default=3,
        help="Number of attempts per (prompt × fixture). Higher = more reliable variance estimate. Default: 3",
    )
    parser.add_argument(
        "--variants",
        nargs="+",
        choices=sorted(PROMPT_VARIANTS),
        default=sorted(PROMPT_VARIANTS),
        help="Which prompt variants to run. Default: all.",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        default=None,
        help="Override OPENROUTER_MODEL — run the full matrix once per listed model id. Default: just OPENROUTER_MODEL (or anthropic/claude-sonnet-4.5).",
    )
    parser.add_argument(
        "--fixtures",
        nargs="+",
        default=None,
        help="Optional subset of transcript fixture ids (filename stems) to run.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned matrix and exit without calling OpenRouter.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    api_key = os.environ.get("OPENROUTER_API_KEY")
    default_model = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5")
    models = args.models if args.models else [default_model]
    base_url = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    timeout_seconds = float(os.environ.get("OPENROUTER_TIMEOUT_SECONDS", "120"))

    if not args.dry_run and not api_key:
        print("OPENROUTER_API_KEY is not set. Export it or pass --dry-run.", file=sys.stderr)
        return 2

    fixtures_all = _load_transcripts()
    if args.fixtures:
        wanted = set(args.fixtures)
        fixtures = [f for f in fixtures_all if f["id"] in wanted]
        missing = wanted - {f["id"] for f in fixtures}
        if missing:
            print(f"Unknown fixture ids: {sorted(missing)}", file=sys.stderr)
            return 2
    else:
        fixtures = fixtures_all

    plan: list[tuple[str, str, dict[str, Any], int]] = []
    for m in models:
        for v in args.variants:
            for f in fixtures:
                for attempt in range(1, args.runs + 1):
                    plan.append((m, v, f, attempt))

    LOGGER.info(
        "Plan: %d calls (models=%s variants=%s fixtures=%d runs=%d)",
        len(plan),
        models,
        args.variants,
        len(fixtures),
        args.runs,
    )

    if args.dry_run:
        for m, v, f, a in plan:
            print(f"  {m} · {v} · {f['id']} · attempt {a}")
        return 0

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results_dir = RESULTS_ROOT / timestamp
    results_dir.mkdir(parents=True, exist_ok=True)
    runs_path = results_dir / "runs.jsonl"

    runs: list[dict[str, Any]] = []
    with runs_path.open("w", encoding="utf-8") as runs_file:
        for index, (model, variant, fixture, attempt) in enumerate(plan, start=1):
            LOGGER.info(
                "[%d/%d] %s · %s · %s · attempt %d",
                index,
                len(plan),
                model,
                variant,
                fixture["id"],
                attempt,
            )
            row = _run_one(
                prompt_variant=variant,
                prompt_text=PROMPT_VARIANTS[variant],
                fixture=fixture,
                attempt=attempt,
                api_key=api_key or "",
                model=model,
                base_url=base_url,
                timeout_seconds=timeout_seconds,
            )
            runs.append(row)
            runs_file.write(json.dumps(row, ensure_ascii=False) + "\n")
            runs_file.flush()
            if row["error"]:
                LOGGER.warning("  -> error: %s", row["error"])
            else:
                LOGGER.info(
                    "  -> %d/%d assertions passed (%.2fs)",
                    row["passed_count"],
                    row["total_count"],
                    row["latency_seconds"],
                )

    report_path = _write_report(results_dir, runs, models=models)
    LOGGER.info("Report written to %s", report_path)
    print(f"\nReport: {report_path}")
    print(f"Raw runs: {runs_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
