"""OpenRouter-backed structured meeting summarization."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Sequence
from typing import Literal, Protocol

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from slusko_worker.db.models import (
    QueuedMeeting,
    SummaryActionItemDraft,
    SummaryActionItemOwnerDraft,
    SummaryDecisionDraft,
    SummaryDraft,
    SummaryOpenQuestionDraft,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline.errors import SummarizationFailed

OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_DEFAULT_TIMEOUT_SECONDS = 120.0
_RETRY_DELAYS_SECONDS = (1.0, 5.0, 25.0)
_RETRYABLE_STATUS_CODES = {408, 429}
_SPEAKER_LABEL_RE = re.compile(r"^SPEAKER_\d{2,}$")


class _Response(Protocol):
    status_code: int
    text: str

    def json(self) -> object: ...


Requester = Callable[..., _Response]
Sleeper = Callable[[float], None]


class _TextItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str

    @field_validator("text")
    @classmethod
    def _text_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


class _Owner(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["name", "speaker", "unknown"]
    value: str | None = None

    @field_validator("value")
    @classmethod
    def _trim_value(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip()

    @model_validator(mode="after")
    def _validate_owner_union(self) -> _Owner:
        if self.kind in {"name", "speaker"} and not self.value:
            raise ValueError(f"owner kind {self.kind!r} requires a non-empty value")
        if self.kind == "speaker" and self.value is not None:
            if _SPEAKER_LABEL_RE.match(self.value) is None:
                raise ValueError("speaker owner value must match SPEAKER_NN")
        if self.kind == "unknown" and "value" in self.model_fields_set:
            raise ValueError("unknown owner must not include value")
        return self


class _ActionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: str
    owner: _Owner

    @field_validator("task")
    @classmethod
    def _task_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("task must not be blank")
        return value


class _SummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overview: str
    decisions: list[_TextItem]
    action_items: list[_ActionItem] = Field(alias="actionItems")
    open_questions: list[_TextItem] = Field(alias="openQuestions")

    @field_validator("overview")
    @classmethod
    def _overview_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("overview must not be blank")
        return value


class OpenRouterSummarizer:
    """Summarize diarized transcript text through OpenRouter chat completions."""

    def __init__(
        self,
        *,
        api_key: str | None,
        model: str | None,
        base_url: str = OPENROUTER_DEFAULT_BASE_URL,
        timeout_seconds: float = OPENROUTER_DEFAULT_TIMEOUT_SECONDS,
        requester: Requester | None = None,
        sleep: Sleeper = time.sleep,
    ) -> None:
        self._api_key = api_key.strip() if api_key else None
        self._model = model.strip() if model else None
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._requester = requester or self._post
        self._sleep = sleep

    def summarize(
        self,
        *,
        meeting: QueuedMeeting,
        transcript_segments: Sequence[TranscriptSegmentDraft],
    ) -> SummaryDraft:
        """Return one validated structured summary for a meeting transcript."""

        if not self._api_key:
            raise SummarizationFailed("OPENROUTER_API_KEY is required", config_missing=True)
        if not self._model:
            raise SummarizationFailed("OPENROUTER_MODEL is required", config_missing=True)
        if not transcript_segments:
            raise SummarizationFailed("summarization requires at least one transcript segment")

        response = self._request_with_retries(
            payload={
                "model": self._model,
                "messages": [
                    {"role": "system", "content": _system_prompt()},
                    {
                        "role": "user",
                        "content": _user_prompt(
                            meeting=meeting, transcript_segments=transcript_segments
                        ),
                    },
                ],
                "temperature": 0.2,
            }
        )
        content = _extract_message_content(response)
        data = _load_json_object(content)
        return _to_summary_draft(data)

    def _request_with_retries(self, *, payload: dict[str, object]) -> object:
        delays = list(_RETRY_DELAYS_SECONDS)
        attempt = 0
        while True:
            try:
                response = self._requester(
                    f"{self._base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=self._timeout_seconds,
                )
            except httpx.HTTPError as error:
                message = f"OpenRouter request failed: {error}"
                if attempt >= len(delays):
                    raise SummarizationFailed(message) from error
                self._sleep(delays[attempt])
                attempt += 1
                continue

            if response.status_code == 401 or response.status_code == 403:
                raise SummarizationFailed(
                    f"OpenRouter authentication failed with HTTP {response.status_code}",
                    config_missing=True,
                )
            if _is_retryable_status(response.status_code):
                message = (
                    f"OpenRouter request failed with HTTP {response.status_code}: "
                    f"{response.text}"
                )
                if attempt >= len(delays):
                    raise SummarizationFailed(message)
                self._sleep(delays[attempt])
                attempt += 1
                continue
            if response.status_code >= 400:
                raise SummarizationFailed(
                    f"OpenRouter request failed with HTTP {response.status_code}: {response.text}"
                )

            try:
                return response.json()
            except ValueError as error:
                raise SummarizationFailed("OpenRouter returned invalid JSON response") from error

    @staticmethod
    def _post(url: str, *, headers: dict[str, str], json: dict[str, object], timeout: float) -> httpx.Response:
        with httpx.Client() as client:
            return client.post(url, headers=headers, json=json, timeout=timeout)


def _is_retryable_status(status_code: int) -> bool:
    return status_code in _RETRYABLE_STATUS_CODES or 500 <= status_code <= 599


def _extract_message_content(response: object) -> str:
    if not isinstance(response, dict):
        raise SummarizationFailed("OpenRouter response was not a JSON object")
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise SummarizationFailed("OpenRouter response did not include choices")
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise SummarizationFailed("OpenRouter choice was not a JSON object")
    message = first_choice.get("message")
    if not isinstance(message, dict):
        raise SummarizationFailed("OpenRouter choice did not include a message")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise SummarizationFailed("OpenRouter message content was empty")
    return content


def _load_json_object(content: str) -> object:
    try:
        data = json.loads(content)
    except json.JSONDecodeError as error:
        raise SummarizationFailed("OpenRouter summary response was not valid JSON") from error
    if not isinstance(data, dict):
        raise SummarizationFailed("OpenRouter summary response must be a JSON object")
    return data


def _to_summary_draft(data: object) -> SummaryDraft:
    try:
        parsed = _SummaryResponse.model_validate(data)
    except ValidationError as error:
        raise SummarizationFailed(f"OpenRouter summary response was invalid: {error}") from error

    return SummaryDraft(
        overview=parsed.overview,
        decisions=tuple(SummaryDecisionDraft(text=item.text) for item in parsed.decisions),
        action_items=tuple(
            SummaryActionItemDraft(
                task=item.task,
                owner=SummaryActionItemOwnerDraft(
                    kind=item.owner.kind,
                    value=item.owner.value if item.owner.kind != "unknown" else None,
                ),
            )
            for item in parsed.action_items
        ),
        open_questions=tuple(
            SummaryOpenQuestionDraft(text=item.text) for item in parsed.open_questions
        ),
    )


def _system_prompt() -> str:
    return """You summarize meeting transcripts into one strict structured summary.
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


def _user_prompt(
    *, meeting: QueuedMeeting,
    transcript_segments: Sequence[TranscriptSegmentDraft],
) -> str:
    lines = [f"Meeting ID: {meeting.id}", "Transcript:"]
    lines.extend(_format_segment(segment) for segment in transcript_segments)
    return "\n".join(lines)


def _format_segment(segment: TranscriptSegmentDraft) -> str:
    return (
        f"[{_format_timestamp(segment.start_seconds)}-{_format_timestamp(segment.end_seconds)}] "
        f"{segment.speaker_label}: {segment.text}"
    )


def _format_timestamp(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    minutes, seconds_part = divmod(total_seconds, 60)
    hours, minutes_part = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes_part:02d}:{seconds_part:02d}"
    return f"{minutes_part:02d}:{seconds_part:02d}"
