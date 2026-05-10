"""Objective assertions applied to summarization drafts.

Each assertion takes a SummaryDraft (the validated structured summary the
production summarizer would produce) plus the transcript fixture metadata,
and returns (passed: bool, evidence: str). Evidence is a one-line human
explanation that gets surfaced in the report.

Assertions are intentionally objective and substring-based — we don't try
to grade "is the overview a good summary" here. Subjective quality is for
human review of the report.md.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from slusko_worker.db.models import SummaryDraft


_CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")
_SPEAKER_LABEL_RE = re.compile(r"^SPEAKER_\d{2,}$")
# Common Serbian function words. A Serbian-Latin overview should hit at
# least one of these; an English overview should hit none of them.
_SERBIAN_MARKERS = (
    " je ", " su ", " smo ", " ćemo ", " će ", " da ", " sa ",
    " za ", " od ", " na ", " ali ", " ili ", " jeste ",
)
_ENGLISH_MARKERS = (
    " the ", " and ", " is ", " are ", " was ", " will ", " to ",
    " for ", " with ", " of ",
)


@dataclass(frozen=True, slots=True)
class Assertion:
    id: str
    description: str
    passed: bool
    evidence: str


def transcript_text(fixture: dict[str, Any]) -> str:
    return " ".join(seg["text"] for seg in fixture["segments"])


def grade(draft: SummaryDraft, fixture: dict[str, Any]) -> list[Assertion]:
    """Apply every relevant assertion to a single summary draft."""

    transcript = transcript_text(fixture)
    transcript_lower = transcript.lower()
    named_in_transcript = {n.lower() for n in fixture.get("named_people_in_transcript", [])}
    expected_script: str = fixture.get("expected_script", "latin")
    expected_lang: str = fixture["dominant_language"]

    asserts: list[Assertion] = []

    # --- universal assertions ---

    asserts.append(_no_atila_unless_in_transcript(draft, transcript_lower))
    asserts.append(_all_named_owners_appear_in_transcript(draft, transcript_lower))
    asserts.append(_speaker_owners_match_label_format(draft))
    asserts.append(_overview_non_empty(draft))
    asserts.append(_overview_script(draft, expected_script))
    asserts.append(_overview_language(draft, expected_lang))

    # --- per-fixture assertions ---

    fixture_id = fixture["id"]

    if fixture_id == "01_serbian_no_real_names":
        # Strongest version of the smoking-gun: when zero names are in the
        # transcript, every named-owner the model emits is by definition
        # invented.
        asserts.append(_no_named_owners_at_all(draft))

    if fixture_id == "02_english_named_owners":
        # Sanity: model should attribute the migration task to someone — and
        # that someone should be a real participant from the transcript.
        asserts.append(
            _at_least_one_named_owner_among(draft, named_in_transcript)
        )

    if fixture_id == "03_serbian_english_mix_technical":
        # Tech terms preserved in English even though the overview is Serbian.
        asserts.append(
            _overview_preserves_any_term(draft, ("Postgres", "API", "pull request", "deployment"))
        )

    if fixture_id == "04_vague_commitments":
        # Hedged Redis/feature-flag discussion must NOT appear as a decision.
        # The end-of-month export-format drop SHOULD appear as a decision.
        asserts.append(_no_decision_mentions_any(draft, ("redis", "keydb", "feature flag")))
        asserts.append(_at_least_one_decision_mentions_any(draft, ("export format", "deprecat")))

    if fixture_id == "05_relitigated_decision":
        # Wednesday-standup decision should appear at most once, not 3x.
        asserts.append(_at_most_one_decision_mentions(draft, "wednesday"))

    return asserts


# --- universal assertion implementations ---


def _no_atila_unless_in_transcript(draft: SummaryDraft, transcript_lower: str) -> Assertion:
    """The smoking-gun assertion: model must not hallucinate 'Atila' when
    Atila isn't in the transcript. This is the core failure mode the
    improved prompt is meant to fix."""

    atila_in_transcript = "atila" in transcript_lower
    offenders: list[str] = []
    for item in draft.action_items:
        if item.owner.kind == "name" and item.owner.value:
            if "atila" in item.owner.value.lower() and not atila_in_transcript:
                offenders.append(item.owner.value)
    passed = not offenders
    evidence = (
        "no Atila hallucination"
        if passed
        else f"hallucinated owner(s): {offenders!r} (Atila not in transcript)"
    )
    return Assertion(
        id="no_atila_hallucination",
        description="No action-item owner is named 'Atila' unless Atila appears in the transcript.",
        passed=passed,
        evidence=evidence,
    )


def _all_named_owners_appear_in_transcript(
    draft: SummaryDraft, transcript_lower: str
) -> Assertion:
    """Generalization of the Atila check: any named owner must appear as a
    substring in the transcript. Catches hallucinated names beyond just
    Atila."""

    offenders: list[str] = []
    for item in draft.action_items:
        if item.owner.kind == "name" and item.owner.value:
            if item.owner.value.lower() not in transcript_lower:
                offenders.append(item.owner.value)
    passed = not offenders
    evidence = (
        "all named owners appear in transcript"
        if passed
        else f"named owners not in transcript: {offenders!r}"
    )
    return Assertion(
        id="named_owners_appear_in_transcript",
        description="Every kind=name owner value appears as a substring in the transcript.",
        passed=passed,
        evidence=evidence,
    )


def _speaker_owners_match_label_format(draft: SummaryDraft) -> Assertion:
    offenders: list[str] = []
    for item in draft.action_items:
        if item.owner.kind == "speaker":
            value = item.owner.value or ""
            if not _SPEAKER_LABEL_RE.match(value):
                offenders.append(value)
    passed = not offenders
    evidence = (
        "all speaker owners match SPEAKER_NN"
        if passed
        else f"malformed speaker owners: {offenders!r}"
    )
    return Assertion(
        id="speaker_owners_well_formed",
        description="Every kind=speaker owner value matches SPEAKER_NN (two or more digits).",
        passed=passed,
        evidence=evidence,
    )


def _overview_non_empty(draft: SummaryDraft) -> Assertion:
    passed = bool(draft.overview.strip())
    return Assertion(
        id="overview_non_empty",
        description="Overview is not blank.",
        passed=passed,
        evidence="overview present" if passed else "overview is blank",
    )


def _overview_script(draft: SummaryDraft, expected: str) -> Assertion:
    has_cyrillic = bool(_CYRILLIC_RE.search(draft.overview))
    if expected == "latin":
        passed = not has_cyrillic
        evidence = "no Cyrillic" if passed else "overview contains Cyrillic characters"
    else:
        passed = has_cyrillic
        evidence = "Cyrillic present" if passed else "expected Cyrillic, none found"
    return Assertion(
        id=f"overview_script_{expected}",
        description=f"Overview script is {expected} (per ADR-0013 Serbian uses Latin script).",
        passed=passed,
        evidence=evidence,
    )


def _overview_language(draft: SummaryDraft, expected: str) -> Assertion:
    padded = " " + draft.overview.lower() + " "
    serbian_hits = sum(1 for m in _SERBIAN_MARKERS if m in padded)
    english_hits = sum(1 for m in _ENGLISH_MARKERS if m in padded)
    if expected == "sr":
        passed = serbian_hits >= 1 and serbian_hits >= english_hits
        evidence = f"sr_markers={serbian_hits} en_markers={english_hits}"
    elif expected == "en":
        passed = english_hits >= 1 and english_hits > serbian_hits
        evidence = f"en_markers={english_hits} sr_markers={serbian_hits}"
    else:
        passed = True
        evidence = f"unknown expected language {expected!r}, skipping"
    return Assertion(
        id=f"overview_language_{expected}",
        description=f"Overview is dominantly in {expected!r} based on common-word markers.",
        passed=passed,
        evidence=evidence,
    )


# --- per-fixture assertion implementations ---


def _no_named_owners_at_all(draft: SummaryDraft) -> Assertion:
    offenders = [
        item.owner.value
        for item in draft.action_items
        if item.owner.kind == "name"
    ]
    passed = not offenders
    return Assertion(
        id="no_named_owners_when_transcript_has_no_names",
        description="When the transcript contains no real names, no action item should have kind=name.",
        passed=passed,
        evidence="no named owners" if passed else f"invented names: {offenders!r}",
    )


def _at_least_one_named_owner_among(
    draft: SummaryDraft, allowed: set[str]
) -> Assertion:
    matched: list[str] = []
    for item in draft.action_items:
        if item.owner.kind == "name" and item.owner.value:
            if item.owner.value.lower() in allowed or any(
                a in item.owner.value.lower() for a in allowed
            ):
                matched.append(item.owner.value)
    passed = len(matched) >= 1
    return Assertion(
        id="at_least_one_named_owner_from_transcript",
        description="At least one action item is attributed by name to a real participant.",
        passed=passed,
        evidence=f"matched owners: {matched!r}" if matched else "no named owner matched the participant set",
    )


def _overview_preserves_any_term(draft: SummaryDraft, terms: Sequence[str]) -> Assertion:
    overview_lower = draft.overview.lower()
    found = [t for t in terms if t.lower() in overview_lower]
    passed = len(found) >= 1
    return Assertion(
        id="overview_preserves_technical_terms",
        description=f"Overview preserves at least one English technical term from {list(terms)!r}.",
        passed=passed,
        evidence=f"found: {found!r}" if found else f"none of {list(terms)!r} appeared in overview",
    )


def _no_decision_mentions_any(draft: SummaryDraft, banned: Sequence[str]) -> Assertion:
    offenders: list[str] = []
    for d in draft.decisions:
        text_lower = d.text.lower()
        for term in banned:
            if term in text_lower:
                offenders.append(d.text)
                break
    passed = not offenders
    return Assertion(
        id="hedged_topics_not_in_decisions",
        description=f"No decision text mentions hedged topics {list(banned)!r}.",
        passed=passed,
        evidence="hedged topics correctly excluded from decisions" if passed else f"hedged topics in decisions: {offenders!r}",
    )


def _at_least_one_decision_mentions_any(draft: SummaryDraft, terms: Sequence[str]) -> Assertion:
    found: list[str] = []
    for d in draft.decisions:
        text_lower = d.text.lower()
        if any(t in text_lower for t in terms):
            found.append(d.text)
    passed = len(found) >= 1
    return Assertion(
        id="genuine_decision_captured",
        description=f"At least one decision mentions one of {list(terms)!r} (the genuinely-settled item).",
        passed=passed,
        evidence=f"found decisions: {found!r}" if found else "genuine settled decision missing",
    )


def _at_most_one_decision_mentions(draft: SummaryDraft, term: str) -> Assertion:
    matches = [d.text for d in draft.decisions if term in d.text.lower()]
    passed = len(matches) <= 1
    return Assertion(
        id="no_duplicate_decisions",
        description=f"At most one decision mentions {term!r} (relitigated topic should be deduplicated).",
        passed=passed,
        evidence=f"{len(matches)} decision(s) mention {term!r}: {matches!r}",
    )
