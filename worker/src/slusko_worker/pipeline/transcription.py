"""Whisper transcription stage."""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Protocol

from slusko_worker.db.models import QueuedMeeting, TranscriptionDraft, TranscriptSegmentDraft
from slusko_worker.pipeline.errors import TranscriptionEmpty, TranscriptionFailed
from slusko_worker.pipeline.transliteration import to_latin_script

PLACEHOLDER_SPEAKER_LABEL = "SPEAKER_00"
DEFAULT_WHISPER_MODEL = "large-v3"
DEFAULT_WHISPER_DEVICE = "auto"
DEFAULT_WHISPER_COMPUTE_TYPE = "auto"
DEFAULT_MODEL_CACHE_DIR = "/data/models"
DEFAULT_PROGRESS_MIN_DELTA = 5
DEFAULT_PROGRESS_MIN_INTERVAL_SECONDS = 5.0
EMPTY_TRANSCRIPT_WORD_THRESHOLD = 10
EMPTY_TRANSCRIPT_DURATION_THRESHOLD_SECONDS = 2.0


class WhisperSegment(Protocol):
    start: float
    end: float
    text: str


class WhisperInfo(Protocol):
    duration: float | None
    language: str | None


class WhisperModelLike(Protocol):
    def transcribe(self, audio: str, **kwargs: object) -> tuple[Iterable[WhisperSegment], WhisperInfo]: ...


ModelFactory = Callable[..., WhisperModelLike]
Clock = Callable[[], float]
ProgressCallback = Callable[[int], None]


class WhisperTranscriber:
    """Transcribe normalized audio into timestamped transcript segment drafts."""

    def __init__(
        self,
        *,
        whisper_model: str = DEFAULT_WHISPER_MODEL,
        whisper_device: str = DEFAULT_WHISPER_DEVICE,
        whisper_compute_type: str = DEFAULT_WHISPER_COMPUTE_TYPE,
        model_cache_dir: str = DEFAULT_MODEL_CACHE_DIR,
        progress_min_delta: int = DEFAULT_PROGRESS_MIN_DELTA,
        progress_min_interval_seconds: float = DEFAULT_PROGRESS_MIN_INTERVAL_SECONDS,
        model_factory: ModelFactory | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._whisper_model = whisper_model
        self._whisper_device = whisper_device
        self._whisper_compute_type = whisper_compute_type
        self._model_cache_dir = model_cache_dir
        self._progress_min_delta = max(1, progress_min_delta)
        self._progress_min_interval_seconds = max(0.0, progress_min_interval_seconds)
        self._model_factory = model_factory or default_model_factory
        self._clock = clock or time.monotonic
        self._model: WhisperModelLike | None = None

    def transcribe(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        progress: ProgressCallback,
    ) -> TranscriptionDraft:
        if not normalized_path.is_file():
            raise TranscriptionFailed(
                f"normalized audio is missing for meeting {meeting.id}: {normalized_path}"
            )

        model = self._load_model()
        try:
            raw_segments, info = model.transcribe(
                str(normalized_path),
                language=meeting.language.value if meeting.language is not None else None,
                condition_on_previous_text=False,
            )
        except Exception as error:
            raise TranscriptionFailed(str(error) or error.__class__.__name__) from error

        duration = _finite_positive_duration(getattr(info, "duration", None))
        drafts: list[TranscriptSegmentDraft] = []
        last_progress = 0
        last_emit_at = self._clock()

        try:
            for raw_segment in raw_segments:
                if duration is not None:
                    candidate_progress = _progress_from_segment_end(
                        raw_segment.end, duration
                    )
                    if candidate_progress > last_progress:
                        now = self._clock()
                        if (
                            candidate_progress - last_progress >= self._progress_min_delta
                            or now - last_emit_at
                            >= self._progress_min_interval_seconds
                        ):
                            progress(candidate_progress)
                            last_progress = candidate_progress
                            last_emit_at = now

                text = to_latin_script(raw_segment.text.strip())
                if not text:
                    continue
                drafts.append(
                    TranscriptSegmentDraft(
                        start_seconds=float(raw_segment.start),
                        end_seconds=float(raw_segment.end),
                        speaker_label=PLACEHOLDER_SPEAKER_LABEL,
                        text=text,
                    )
                )
        except Exception as error:
            raise TranscriptionFailed(str(error) or error.__class__.__name__) from error

        if _is_empty_transcript(drafts):
            raise TranscriptionEmpty()

        return TranscriptionDraft(
            segments=tuple(drafts),
            detected_language=_detected_language_for_meeting(meeting, info),
        )

    def preload_model(self) -> None:
        self._load_model()

    def _load_model(self) -> WhisperModelLike:
        if self._model is None:
            try:
                self._model = self._model_factory(
                    self._whisper_model,
                    device=self._whisper_device,
                    compute_type=self._whisper_compute_type,
                    download_root=self._model_cache_dir,
                )
            except Exception as error:
                raise TranscriptionFailed(str(error) or error.__class__.__name__) from error
        return self._model


def default_model_factory(*args: Any, **kwargs: Any) -> WhisperModelLike:
    """Import faster-whisper only when the first transcription actually runs."""

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise TranscriptionFailed("Required Python package is missing: faster-whisper") from error
    return WhisperModel(*args, **kwargs)


def _finite_positive_duration(duration: float | None) -> float | None:
    if duration is None:
        return None
    try:
        value = float(duration)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return value


def _progress_from_segment_end(segment_end: float, duration: float) -> int:
    try:
        progress = math.floor((float(segment_end) / duration) * 100)
    except (OverflowError, ValueError):
        return 0
    return max(0, min(99, progress))


def _detected_language_for_meeting(
    meeting: QueuedMeeting, info: WhisperInfo
) -> str | None:
    if meeting.language is not None:
        return None
    language = getattr(info, "language", None)
    if language is None:
        return None
    value = str(language).strip()
    return value or None


def _is_empty_transcript(segments: list[TranscriptSegmentDraft]) -> bool:
    if not segments:
        return True

    word_count = sum(len(segment.text.split()) for segment in segments)
    has_long_segment = any(
        segment.end_seconds - segment.start_seconds > EMPTY_TRANSCRIPT_DURATION_THRESHOLD_SECONDS
        for segment in segments
    )
    return word_count < EMPTY_TRANSCRIPT_WORD_THRESHOLD and not has_long_segment
