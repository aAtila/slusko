from __future__ import annotations

import json
from dataclasses import dataclass
from uuid import UUID

import httpx
import pytest

from slusko_worker.db.models import (
    MeetingStatus,
    QueuedMeeting,
    SummaryActionItemDraft,
    SummaryActionItemOwnerDraft,
    SummaryDecisionDraft,
    SummaryDraft,
    SummaryOpenQuestionDraft,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline.errors import SummarizationFailed
from slusko_worker.pipeline.summarization import OpenRouterSummarizer


MEETING_ID = UUID("00000000-0000-0000-0000-000000000001")


def queued_meeting() -> QueuedMeeting:
    return QueuedMeeting(
        id=MEETING_ID,
        status=MeetingStatus.SUMMARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


def transcript_segments() -> list[TranscriptSegmentDraft]:
    return [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=4.2,
            speaker_label="SPEAKER_00",
            text="Atila will send the launch checklist.",
        ),
        TranscriptSegmentDraft(
            start_seconds=65.0,
            end_seconds=70.0,
            speaker_label="SPEAKER_01",
            text="Dogovorili smo demo u petak.",
        ),
    ]


@dataclass
class FakeResponse:
    status_code: int
    body: object
    text: str = ""

    def json(self) -> object:
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


def openrouter_body(content: object) -> dict[str, object]:
    return {"choices": [{"message": {"content": json.dumps(content)}}]}


def test_openrouter_summarizer_posts_transcript_and_returns_validated_summary() -> None:
    calls: list[dict[str, object]] = []
    response_content = {
        "overview": "Demo je zakazan, a launch checklist ima vlasnika.",
        "decisions": [{"text": "Demo će biti u petak."}],
        "actionItems": [
            {"task": "Send the launch checklist", "owner": {"kind": "name", "value": "Atila"}},
            {"task": "Confirm demo room", "owner": {"kind": "speaker", "value": "SPEAKER_100"}},
            {"task": "Publish notes", "owner": {"kind": "unknown"}},
        ],
        "openQuestions": [{"text": "Ko šalje pozivnicu?"}],
    }

    def requester(url: str, **kwargs: object) -> FakeResponse:
        calls.append({"url": url, **kwargs})
        return FakeResponse(200, openrouter_body(response_content))

    summarizer = OpenRouterSummarizer(
        api_key="test-key",
        model="anthropic/test-model",
        base_url="https://openrouter.test/api/v1/",
        timeout_seconds=12.5,
        requester=requester,
        sleep=lambda _delay: None,
    )

    summary = summarizer.summarize(
        meeting=queued_meeting(), transcript_segments=transcript_segments()
    )

    assert summary == SummaryDraft(
        overview="Demo je zakazan, a launch checklist ima vlasnika.",
        decisions=(SummaryDecisionDraft(text="Demo će biti u petak."),),
        action_items=(
            SummaryActionItemDraft(
                task="Send the launch checklist",
                owner=SummaryActionItemOwnerDraft(kind="name", value="Atila"),
            ),
            SummaryActionItemDraft(
                task="Confirm demo room",
                owner=SummaryActionItemOwnerDraft(kind="speaker", value="SPEAKER_100"),
            ),
            SummaryActionItemDraft(
                task="Publish notes",
                owner=SummaryActionItemOwnerDraft(kind="unknown"),
            ),
        ),
        open_questions=(SummaryOpenQuestionDraft(text="Ko šalje pozivnicu?"),),
    )
    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == "https://openrouter.test/api/v1/chat/completions"
    assert call["headers"] == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
    }
    assert call["timeout"] == 12.5
    payload = call["json"]
    assert isinstance(payload, dict)
    assert payload["model"] == "anthropic/test-model"
    assert payload["temperature"] == 0.2
    messages = payload["messages"]
    assert isinstance(messages, list)
    assert messages[0]["role"] == "system"
    assert "dominant transcript language" in messages[0]["content"]
    assert "Serbian" in messages[0]["content"]
    assert "[00:00-00:04] SPEAKER_00: Atila will send the launch checklist." in messages[1]["content"]
    assert "[01:05-01:10] SPEAKER_01: Dogovorili smo demo u petak." in messages[1]["content"]


def test_openrouter_summarizer_classifies_missing_config_without_requesting() -> None:
    requested = False

    def requester(*_args: object, **_kwargs: object) -> FakeResponse:
        nonlocal requested
        requested = True
        return FakeResponse(200, {})

    summarizer = OpenRouterSummarizer(
        api_key=None,
        model="anthropic/test-model",
        requester=requester,
        sleep=lambda _delay: None,
    )

    with pytest.raises(SummarizationFailed) as error:
        summarizer.summarize(meeting=queued_meeting(), transcript_segments=transcript_segments())

    assert requested is False
    failure = error.value.to_failure()
    assert failure.error_kind.value == "config_missing"
    assert failure.failed_at_stage == MeetingStatus.SUMMARIZING


def test_openrouter_summarizer_retries_transient_http_failures_then_succeeds() -> None:
    attempts = [
        FakeResponse(429, {}, text="rate limited"),
        FakeResponse(500, {}, text="provider down"),
        FakeResponse(200, openrouter_body({
            "overview": "Recovered summary.",
            "decisions": [],
            "actionItems": [],
            "openQuestions": [],
        })),
    ]
    delays: list[float] = []

    def requester(*_args: object, **_kwargs: object) -> FakeResponse:
        return attempts.pop(0)

    summarizer = OpenRouterSummarizer(
        api_key="key",
        model="model",
        requester=requester,
        sleep=delays.append,
    )

    summary = summarizer.summarize(meeting=queued_meeting(), transcript_segments=transcript_segments())

    assert summary.overview == "Recovered summary."
    assert delays == [1.0, 5.0]


def test_openrouter_summarizer_retries_transport_errors_before_failing() -> None:
    delays: list[float] = []

    def requester(*_args: object, **_kwargs: object) -> FakeResponse:
        raise httpx.ConnectError("network down")

    summarizer = OpenRouterSummarizer(
        api_key="key",
        model="model",
        requester=requester,
        sleep=delays.append,
    )

    with pytest.raises(SummarizationFailed, match="network down"):
        summarizer.summarize(meeting=queued_meeting(), transcript_segments=transcript_segments())

    assert delays == [1.0, 5.0, 25.0]


@pytest.mark.parametrize(
    "content, match",
    [
        ("not-json", "not valid JSON"),
        ({"overview": "", "decisions": [], "actionItems": [], "openQuestions": []}, "overview"),
        ({"overview": "Ok", "decisions": [], "actionItems": [{"task": "x", "owner": {"kind": "speaker", "value": "Speaker 1"}}], "openQuestions": []}, "SPEAKER_NN"),
        ({"overview": "Ok", "decisions": [], "actionItems": [{"task": "x", "owner": {"kind": "unknown", "value": "Atila"}}], "openQuestions": []}, "unknown owner"),
        ({"overview": "Ok", "decisions": [], "actionItems": [{"task": "x", "owner": {"kind": "unknown", "value": None}}], "openQuestions": []}, "unknown owner"),
    ],
)
def test_openrouter_summarizer_rejects_malformed_or_schema_invalid_responses(
    content: object,
    match: str,
) -> None:
    body = {"choices": [{"message": {"content": content if isinstance(content, str) else json.dumps(content)}}]}

    summarizer = OpenRouterSummarizer(
        api_key="key",
        model="model",
        requester=lambda *_args, **_kwargs: FakeResponse(200, body),
        sleep=lambda _delay: None,
    )

    with pytest.raises(SummarizationFailed, match=match):
        summarizer.summarize(meeting=queued_meeting(), transcript_segments=transcript_segments())


def test_openrouter_summarizer_classifies_unauthorized_as_config_missing() -> None:
    summarizer = OpenRouterSummarizer(
        api_key="bad-key",
        model="model",
        requester=lambda *_args, **_kwargs: FakeResponse(401, {}, text="unauthorized"),
        sleep=lambda _delay: None,
    )

    with pytest.raises(SummarizationFailed) as error:
        summarizer.summarize(meeting=queued_meeting(), transcript_segments=transcript_segments())

    assert error.value.to_failure().error_kind.value == "config_missing"


def test_openrouter_summarizer_does_not_retry_non_retryable_http_failures() -> None:
    calls = 0

    def requester(*_args: object, **_kwargs: object) -> FakeResponse:
        nonlocal calls
        calls += 1
        return FakeResponse(400, {}, text="context too large")

    summarizer = OpenRouterSummarizer(
        api_key="key",
        model="model",
        requester=requester,
        sleep=lambda _delay: None,
    )

    with pytest.raises(SummarizationFailed, match="HTTP 400"):
        summarizer.summarize(meeting=queued_meeting(), transcript_segments=transcript_segments())

    assert calls == 1
