from __future__ import annotations

from uuid import UUID

from slusko_worker.db.models import (
    MeetingStatus,
    QueuedMeeting,
    SummaryRegenerationStatus,
)


def test_summary_regeneration_status_mirrors_drizzle_enum() -> None:
    assert [status.value for status in SummaryRegenerationStatus] == [
        "idle",
        "pending",
        "processing",
        "failed",
    ]


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
