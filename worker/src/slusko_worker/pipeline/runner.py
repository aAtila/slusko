"""Pipeline handoff for claimed meetings."""

from __future__ import annotations

import logging
from typing import Protocol

from slusko_worker.db.models import ErrorKind, MeetingStatus, QueuedMeeting
from slusko_worker.pipeline.errors import PipelineError

logger = logging.getLogger(__name__)


class RecoveryQueue(Protocol):
    def mark_recovery_not_implemented(self, meeting: QueuedMeeting) -> None: ...


class NormalizationQueue(RecoveryQueue, Protocol):
    def mark_normalization_started(self, meeting: QueuedMeeting) -> None: ...

    def mark_normalization_succeeded(
        self, *, meeting: QueuedMeeting, duration_seconds: int
    ) -> None: ...

    def mark_failure(
        self,
        *,
        meeting: QueuedMeeting,
        error_kind: ErrorKind,
        error_message: str,
        failed_at_stage: MeetingStatus,
    ) -> None: ...


class NormalizationResult(Protocol):
    duration_seconds: int


class Normalizer(Protocol):
    def normalize(self, meeting: QueuedMeeting) -> NormalizationResult: ...


class PipelineProcessor:
    """Dispatch claimed meetings to the currently implemented pipeline stages."""

    def __init__(self, *, queue: NormalizationQueue, normalizer: Normalizer) -> None:
        self._queue = queue
        self._normalizer = normalizer

    def process(self, meeting: QueuedMeeting) -> None:
        if meeting.status in {MeetingStatus.PENDING, MeetingStatus.NORMALIZING}:
            self._queue.mark_normalization_started(meeting)
            try:
                result = self._normalizer.normalize(meeting)
            except PipelineError as error:
                failure = error.to_failure()
                self._queue.mark_failure(
                    meeting=meeting,
                    error_kind=failure.error_kind,
                    error_message=failure.error_message,
                    failed_at_stage=failure.failed_at_stage,
                )
                return
            except Exception as error:
                logger.exception(
                    "unexpected normalization failure for meeting %s", meeting.id
                )
                self._queue.mark_failure(
                    meeting=meeting,
                    error_kind=ErrorKind.UNKNOWN,
                    error_message=str(error) or error.__class__.__name__,
                    failed_at_stage=MeetingStatus.NORMALIZING,
                )
                return
            self._queue.mark_normalization_succeeded(
                meeting=meeting,
                duration_seconds=result.duration_seconds,
            )
            return

        logger.warning(
            "meeting %s claimed at %s, but recovery beyond normalization is not implemented",
            meeting.id,
            meeting.status.value,
        )
        self._queue.mark_recovery_not_implemented(meeting)


class RecoveryStubProcessor:
    """Boundary processor retained for tests/compatibility with the issue #7 normalization-only slice."""

    def __init__(self, queue: RecoveryQueue) -> None:
        self._queue = queue

    def process(self, meeting: QueuedMeeting) -> None:
        if meeting.status in {MeetingStatus.PENDING, MeetingStatus.NORMALIZING}:
            raise RuntimeError(
                "RecoveryStubProcessor must not process pending/normalizing meetings"
            )

        logger.warning(
            "meeting %s claimed at %s, but recovery beyond normalization is not implemented",
            meeting.id,
            meeting.status.value,
        )
        self._queue.mark_recovery_not_implemented(meeting)
