from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from slusko_worker.db.models import ErrorKind, MeetingStatus, QueuedMeeting
from slusko_worker.pipeline.errors import NormalizationFailed
from slusko_worker.pipeline.runner import PipelineProcessor


MEETING_ID = UUID("00000000-0000-0000-0000-000000000001")


def queued_meeting(status: MeetingStatus = MeetingStatus.PENDING) -> QueuedMeeting:
    return QueuedMeeting(
        id=MEETING_ID,
        status=status,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


@dataclass(frozen=True)
class FakeNormalizationResult:
    duration_seconds: int


class FakeQueue:
    def __init__(self) -> None:
        self.events: list[object] = []

    def mark_normalization_started(self, meeting: QueuedMeeting) -> None:
        self.events.append(("normalization_started", meeting.id))

    def mark_normalization_succeeded(
        self, *, meeting: QueuedMeeting, duration_seconds: int
    ) -> None:
        self.events.append(("normalization_succeeded", meeting.id, duration_seconds))

    def mark_failure(
        self,
        *,
        meeting: QueuedMeeting,
        error_kind: ErrorKind,
        error_message: str,
        failed_at_stage: MeetingStatus,
    ) -> None:
        self.events.append(
            ("failure", meeting.id, error_kind, error_message, failed_at_stage)
        )

    def mark_recovery_not_implemented(self, meeting: QueuedMeeting) -> None:
        self.events.append(("recovery_not_implemented", meeting.id, meeting.status))


class FakeNormalizer:
    def __init__(
        self,
        result: FakeNormalizationResult | None = None,
        error: Exception | None = None,
        shared_events: list[object] | None = None,
    ) -> None:
        self.result = result
        self.error = error
        self.events: list[object] = []
        self.shared_events = shared_events

    def normalize(self, meeting: QueuedMeeting) -> FakeNormalizationResult:
        event = ("normalize", meeting.id)
        self.events.append(event)
        if self.shared_events is not None:
            self.shared_events.append(event)
        if self.error is not None:
            raise self.error
        assert self.result is not None
        return self.result


def test_pending_meeting_runs_normalization_and_finishes_this_vertical_slice() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(
        FakeNormalizationResult(duration_seconds=42), shared_events=queue.events
    )
    processor = PipelineProcessor(queue=queue, normalizer=normalizer)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events == [
        ("normalization_started", MEETING_ID),
        ("normalize", MEETING_ID),
        ("normalization_succeeded", MEETING_ID, 42),
    ]
    assert normalizer.events == [("normalize", MEETING_ID)]


def test_unexpected_normalization_error_writes_unknown_failure() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(error=OSError("filesystem refused rename"))
    processor = PipelineProcessor(queue=queue, normalizer=normalizer)

    processor.process(queued_meeting(MeetingStatus.NORMALIZING))

    assert queue.events == [
        ("normalization_started", MEETING_ID),
        (
            "failure",
            MEETING_ID,
            ErrorKind.UNKNOWN,
            "filesystem refused rename",
            MeetingStatus.NORMALIZING,
        ),
    ]


def test_normalization_failure_writes_adr_0007_error_fields() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(
        error=NormalizationFailed("ffmpeg failed: corrupt input")
    )
    processor = PipelineProcessor(queue=queue, normalizer=normalizer)

    processor.process(queued_meeting(MeetingStatus.NORMALIZING))

    assert queue.events == [
        ("normalization_started", MEETING_ID),
        (
            "failure",
            MEETING_ID,
            ErrorKind.NORMALIZATION_FAILED,
            "ffmpeg failed: corrupt input",
            MeetingStatus.NORMALIZING,
        ),
    ]
