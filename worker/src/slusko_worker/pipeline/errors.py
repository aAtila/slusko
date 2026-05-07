"""Pipeline exception types and ADR-0007 failure mapping."""

from __future__ import annotations

from dataclasses import dataclass

from slusko_worker.db.models import ErrorKind, MeetingStatus


@dataclass(frozen=True, slots=True)
class PipelineFailure:
    error_kind: ErrorKind
    error_message: str
    failed_at_stage: MeetingStatus


class PipelineError(Exception):
    """Base class for errors that should be persisted to meeting failure fields."""

    def to_failure(self) -> PipelineFailure:
        return PipelineFailure(
            error_kind=ErrorKind.UNKNOWN,
            error_message=str(self) or "Unknown pipeline error",
            failed_at_stage=MeetingStatus.NORMALIZING,
        )


class NormalizationFailed(PipelineError):
    """Normalization stage failed before producing a usable normalized artifact."""

    def __init__(self, message: str, *, config_missing: bool = False) -> None:
        super().__init__(message)
        self.config_missing = config_missing

    def to_failure(self) -> PipelineFailure:
        return PipelineFailure(
            error_kind=ErrorKind.CONFIG_MISSING
            if self.config_missing
            else ErrorKind.NORMALIZATION_FAILED,
            error_message=str(self),
            failed_at_stage=MeetingStatus.NORMALIZING,
        )


class TranscriptionFailed(PipelineError):
    """Transcription stage failed before producing usable transcript segments."""

    def to_failure(self) -> PipelineFailure:
        return PipelineFailure(
            error_kind=ErrorKind.TRANSCRIPTION_FAILED,
            error_message=str(self),
            failed_at_stage=MeetingStatus.TRANSCRIBING,
        )


class DiarizationFailed(PipelineError):
    """Diarization stage failed before producing usable speaker labels."""

    def __init__(self, message: str, *, config_missing: bool = False) -> None:
        super().__init__(message)
        self.config_missing = config_missing

    def to_failure(self) -> PipelineFailure:
        return PipelineFailure(
            error_kind=ErrorKind.CONFIG_MISSING
            if self.config_missing
            else ErrorKind.DIARIZATION_FAILED,
            error_message=str(self),
            failed_at_stage=MeetingStatus.DIARIZING,
        )


class SummarizationFailed(PipelineError):
    """Summarization stage failed before producing a usable Summary row."""

    def __init__(self, message: str, *, config_missing: bool = False) -> None:
        super().__init__(message)
        self.config_missing = config_missing

    def to_failure(self) -> PipelineFailure:
        return PipelineFailure(
            error_kind=ErrorKind.CONFIG_MISSING
            if self.config_missing
            else ErrorKind.SUMMARIZATION_FAILED,
            error_message=str(self),
            failed_at_stage=MeetingStatus.SUMMARIZING,
        )


class TranscriptionEmpty(PipelineError):
    """Whisper completed, but ADR-0007 says the transcript has no speech."""

    DEFAULT_MESSAGE = (
        "No speech detected. The recording may be silent, music-only, or corrupted."
    )

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.DEFAULT_MESSAGE)

    def to_failure(self) -> PipelineFailure:
        return PipelineFailure(
            error_kind=ErrorKind.TRANSCRIPTION_EMPTY,
            error_message=str(self),
            failed_at_stage=MeetingStatus.TRANSCRIBING,
        )
