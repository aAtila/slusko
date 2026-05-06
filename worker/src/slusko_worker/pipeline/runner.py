"""Pipeline handoff for claimed meetings."""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Protocol

from slusko_worker.db.models import (
    ErrorKind,
    MeetingStatus,
    QueuedMeeting,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline.errors import PipelineError
from slusko_worker.pipeline.normalization import NORMALIZED_FILENAME

logger = logging.getLogger(__name__)


class RecoveryQueue(Protocol):
    def mark_recovery_not_implemented(self, meeting: QueuedMeeting) -> None: ...


class PipelineQueue(RecoveryQueue, Protocol):
    def mark_normalization_started(self, meeting: QueuedMeeting) -> None: ...

    def mark_transcription_started(
        self, *, meeting: QueuedMeeting, duration_seconds: int | None = None
    ) -> None: ...

    def mark_transcription_progress(
        self, *, meeting: QueuedMeeting, progress: int
    ) -> None: ...

    def mark_transcription_succeeded(
        self, *, meeting: QueuedMeeting, segments: Sequence[TranscriptSegmentDraft]
    ) -> None: ...

    def load_transcript_segments(
        self, meeting: QueuedMeeting
    ) -> list[TranscriptSegmentDraft]: ...

    def mark_diarization_started(self, meeting: QueuedMeeting) -> None: ...

    def mark_diarization_succeeded(
        self, *, meeting: QueuedMeeting, segments: Sequence[TranscriptSegmentDraft]
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
    normalized_path: Path


class Normalizer(Protocol):
    def normalize(self, meeting: QueuedMeeting) -> NormalizationResult: ...


class Transcriber(Protocol):
    def transcribe(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        progress: Callable[[int], None],
    ) -> Sequence[TranscriptSegmentDraft]: ...


class Diarizer(Protocol):
    def diarize(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        transcript_segments: Sequence[TranscriptSegmentDraft],
    ) -> Sequence[TranscriptSegmentDraft]: ...


class PipelineProcessor:
    """Dispatch claimed meetings to the currently implemented pipeline stages."""

    def __init__(
        self,
        *,
        queue: PipelineQueue,
        normalizer: Normalizer,
        transcriber: Transcriber,
        diarizer: Diarizer,
        meetings_dir: str | Path,
    ) -> None:
        self._queue = queue
        self._normalizer = normalizer
        self._transcriber = transcriber
        self._diarizer = diarizer
        self._meetings_dir = Path(meetings_dir)

    def process(self, meeting: QueuedMeeting) -> None:
        if meeting.status in {MeetingStatus.PENDING, MeetingStatus.NORMALIZING}:
            self._process_from_normalization(meeting)
            return

        if meeting.status == MeetingStatus.TRANSCRIBING:
            normalized_path = self._normalized_path(meeting)
            self._process_transcription(
                meeting=meeting,
                normalized_path=normalized_path,
                duration_seconds=None,
            )
            return

        if meeting.status == MeetingStatus.DIARIZING:
            self._process_diarization_reentry(meeting)
            return

        logger.warning(
            "meeting %s claimed at %s, but recovery beyond transcription is not implemented",
            meeting.id,
            meeting.status.value,
        )
        self._queue.mark_recovery_not_implemented(meeting)

    def _process_from_normalization(self, meeting: QueuedMeeting) -> None:
        self._queue.mark_normalization_started(meeting)
        try:
            result = self._normalizer.normalize(meeting)
        except PipelineError as error:
            self._write_pipeline_failure(meeting, error)
            return
        except Exception as error:
            logger.exception("unexpected normalization failure for meeting %s", meeting.id)
            self._queue.mark_failure(
                meeting=meeting,
                error_kind=ErrorKind.UNKNOWN,
                error_message=str(error) or error.__class__.__name__,
                failed_at_stage=MeetingStatus.NORMALIZING,
            )
            return

        self._process_transcription(
            meeting=meeting,
            normalized_path=result.normalized_path,
            duration_seconds=result.duration_seconds,
        )

    def _process_transcription(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        duration_seconds: int | None,
    ) -> None:
        self._queue.mark_transcription_started(
            meeting=meeting, duration_seconds=duration_seconds
        )
        try:
            segments = self._transcriber.transcribe(
                meeting=meeting,
                normalized_path=normalized_path,
                progress=lambda progress: self._safe_mark_transcription_progress(
                    meeting=meeting, progress=progress
                ),
            )
        except PipelineError as error:
            self._write_pipeline_failure(meeting, error)
            return
        except Exception as error:
            logger.exception("unexpected transcription failure for meeting %s", meeting.id)
            self._queue.mark_failure(
                meeting=meeting,
                error_kind=ErrorKind.UNKNOWN,
                error_message=str(error) or error.__class__.__name__,
                failed_at_stage=MeetingStatus.TRANSCRIBING,
            )
            return

        self._queue.mark_transcription_succeeded(meeting=meeting, segments=segments)
        transcript_segments = self._load_transcript_segments_for_diarization(meeting)
        if transcript_segments is None:
            return
        self._process_diarization(
            meeting=meeting,
            normalized_path=normalized_path,
            transcript_segments=transcript_segments,
        )

    def _process_diarization_reentry(self, meeting: QueuedMeeting) -> None:
        transcript_segments = self._load_transcript_segments_for_diarization(meeting)
        if transcript_segments is None:
            return

        self._process_diarization(
            meeting=meeting,
            normalized_path=self._normalized_path(meeting),
            transcript_segments=transcript_segments,
        )

    def _load_transcript_segments_for_diarization(
        self, meeting: QueuedMeeting
    ) -> list[TranscriptSegmentDraft] | None:
        try:
            return self._queue.load_transcript_segments(meeting)
        except Exception as error:
            logger.exception("failed to load transcript rows for meeting %s", meeting.id)
            self._queue.mark_failure(
                meeting=meeting,
                error_kind=ErrorKind.UNKNOWN,
                error_message=str(error) or error.__class__.__name__,
                failed_at_stage=MeetingStatus.DIARIZING,
            )
            return None

    def _process_diarization(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        transcript_segments: Sequence[TranscriptSegmentDraft],
    ) -> None:
        self._queue.mark_diarization_started(meeting)
        try:
            diarized_segments = self._diarizer.diarize(
                meeting=meeting,
                normalized_path=normalized_path,
                transcript_segments=transcript_segments,
            )
        except PipelineError as error:
            self._write_pipeline_failure(meeting, error)
            return
        except Exception as error:
            logger.exception("unexpected diarization failure for meeting %s", meeting.id)
            self._queue.mark_failure(
                meeting=meeting,
                error_kind=ErrorKind.UNKNOWN,
                error_message=str(error) or error.__class__.__name__,
                failed_at_stage=MeetingStatus.DIARIZING,
            )
            return

        self._queue.mark_diarization_succeeded(
            meeting=meeting, segments=diarized_segments
        )

    def _safe_mark_transcription_progress(
        self, *, meeting: QueuedMeeting, progress: int
    ) -> None:
        try:
            self._queue.mark_transcription_progress(meeting=meeting, progress=progress)
        except Exception:
            logger.exception(
                "transcription progress write failed for meeting %s", meeting.id
            )

    def _normalized_path(self, meeting: QueuedMeeting) -> Path:
        return self._meetings_dir / str(meeting.id) / NORMALIZED_FILENAME

    def _write_pipeline_failure(
        self, meeting: QueuedMeeting, error: PipelineError
    ) -> None:
        failure = error.to_failure()
        self._queue.mark_failure(
            meeting=meeting,
            error_kind=failure.error_kind,
            error_message=failure.error_message,
            failed_at_stage=failure.failed_at_stage,
        )


class RecoveryStubProcessor:
    """Boundary processor retained for tests/compatibility with future slices."""

    def __init__(self, queue: RecoveryQueue) -> None:
        self._queue = queue

    def process(self, meeting: QueuedMeeting) -> None:
        if meeting.status in {
            MeetingStatus.PENDING,
            MeetingStatus.NORMALIZING,
            MeetingStatus.TRANSCRIBING,
        }:
            raise RuntimeError(
                "RecoveryStubProcessor must not process pending/normalizing/transcribing meetings"
            )

        logger.warning(
            "meeting %s claimed at %s, but recovery beyond transcription is not implemented",
            meeting.id,
            meeting.status.value,
        )
        self._queue.mark_recovery_not_implemented(meeting)
