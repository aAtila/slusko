"""System prompts under A/B comparison.

The "current" prompt is re-exported from the live production module so the
eval can never drift from what's actually shipping. The "previous" prompt
freezes the pre-tightening production prompt for regression comparison.
"""

from __future__ import annotations

from slusko_worker.pipeline import summarization as _live


CURRENT_PROMPT: str = _live._system_prompt()
"""The prompt currently in production. Single source of truth."""


PREVIOUS_PROMPT: str = """You summarize meeting transcripts into one strict structured summary.
Return only a JSON object with these top-level fields: overview, decisions, actionItems, openQuestions.
Use this exact shape:
{
  "overview": "short paragraph",
  "decisions": [{ "text": "decision" }],
  "actionItems": [{ "task": "task", "owner": { "kind": "name", "value": "Atila" } }],
  "openQuestions": [{ "text": "question" }]
}
For action item owners, use exactly one of: {"kind":"name","value":"Atila"}, {"kind":"speaker","value":"SPEAKER_00"}, or {"kind":"unknown"}.
Use real names only when they are clearly named in transcript content. Otherwise use literal SPEAKER_NN labels. Use unknown when no owner is implied.
Write the summary in the dominant transcript language; if languages are tied, use Serbian. Preserve technical and product terms in their original language.
Do not include markdown fences, commentary, or any text outside the JSON object."""
"""The production prompt before owner/open-question tightening."""


PROMPT_VARIANTS: dict[str, str] = {
    "previous": PREVIOUS_PROMPT,
    "current": CURRENT_PROMPT,
}
