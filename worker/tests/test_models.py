from __future__ import annotations

from uuid import UUID

from slusko_worker.db.models import (
    MeetingStatus,
    QueuedMeeting,
    SummaryRegenerationStatus,
    TranscriptionDraft,
    TranscriptionLanguage,
    TranscriptSegmentDraft,
)


def test_summary_regeneration_status_mirrors_drizzle_enum() -> None:
    assert [status.value for status in SummaryRegenerationStatus] == [
        "idle",
        "pending",
        "processing",
        "failed",
    ]


def test_transcription_language_mirrors_requested_meeting_language_values() -> None:
    assert [language.value for language in TranscriptionLanguage] == ["sr", "en"]


def test_queued_meeting_carries_summary_regeneration_fields_needed_by_worker() -> None:
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.DONE,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
        summary_regeneration_status=SummaryRegenerationStatus.PROCESSING,
        summary_regeneration_processing_started_at=None,
    )

    assert meeting.summary_regeneration_status is SummaryRegenerationStatus.PROCESSING
    assert meeting.summary_regeneration_processing_started_at is None
    assert meeting.language is None
    assert meeting.detected_language is None


def test_queued_meeting_carries_language_fields_needed_by_worker() -> None:
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
        language=TranscriptionLanguage.SERBIAN,
        detected_language="sr",
    )

    assert meeting.language is TranscriptionLanguage.SERBIAN
    assert meeting.detected_language == "sr"


def test_transcription_draft_carries_segments_and_detected_language() -> None:
    segment = TranscriptSegmentDraft(
        start_seconds=0.0,
        end_seconds=1.0,
        speaker_label="SPEAKER_00",
        text="Zdravo",
    )

    draft = TranscriptionDraft(segments=(segment,), detected_language="sr")

    assert draft.segments == (segment,)
    assert draft.detected_language == "sr"
