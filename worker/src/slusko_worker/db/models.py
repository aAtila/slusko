"""Narrow schema mirror for queue and pipeline fields the worker owns.

Drizzle migrations in web/app/db are the source of truth. Keep this module
limited to fields the worker needs for claiming work, reporting progress, and
recording failures.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID


class MeetingStatus(StrEnum):
    """Values mirrored from web/app/db/schema.ts meeting_status."""

    PENDING = "pending"
    NORMALIZING = "normalizing"
    TRANSCRIBING = "transcribing"
    DIARIZING = "diarizing"
    SUMMARIZING = "summarizing"
    DONE = "done"
    ERROR = "error"


class ErrorKind(StrEnum):
    """Values mirrored from web/app/db/schema.ts error_kind."""

    NORMALIZATION_FAILED = "normalization_failed"
    TRANSCRIPTION_FAILED = "transcription_failed"
    TRANSCRIPTION_EMPTY = "transcription_empty"
    DIARIZATION_FAILED = "diarization_failed"
    SUMMARIZATION_FAILED = "summarization_failed"
    CONFIG_MISSING = "config_missing"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class TranscriptSegmentDraft:
    """Worker-owned transcript segment payload before DB persistence."""

    start_seconds: float
    end_seconds: float
    speaker_label: str
    text: str


@dataclass(frozen=True, slots=True)
class QueuedMeeting:
    """Queue/pipeline fields for a meeting row.

    The worker intentionally does not mirror list-view, transcript, summary, or
    speaker-mapping fields until it needs to read or write them.
    """

    id: UUID
    status: MeetingStatus
    resume_from_stage: MeetingStatus | None
    transcription_progress: int | None
    error_kind: ErrorKind | None
    error_message: str | None
    failed_at_stage: MeetingStatus | None
