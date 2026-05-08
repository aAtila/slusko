"""Speaker diarization stage and pure speaker-assignment algorithm."""

from __future__ import annotations

import importlib
import inspect
import math
from collections.abc import Callable, Sequence
from dataclasses import replace
from functools import wraps
from pathlib import Path
from typing import Any, Protocol

from slusko_worker.db.models import (
    DiarizationSegmentDraft,
    QueuedMeeting,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline.errors import DiarizationFailed

DEFAULT_PYANNOTE_MODEL = "pyannote/speaker-diarization-3.1"
DEFAULT_MODEL_CACHE_DIR = "/data/models"
DEFAULT_GAP_TOLERANCE_SECONDS = 0.5
FALLBACK_SPEAKER_LABEL = "SPEAKER_00"


class PyannoteTurn(Protocol):
    start: float
    end: float


class PyannoteAnnotation(Protocol):
    def itertracks(self, *, yield_label: bool = False) -> object: ...


class PyannotePipelineLike(Protocol):
    def __call__(self, audio: str) -> PyannoteAnnotation: ...


PipelineFactory = Callable[..., PyannotePipelineLike]


class PyannoteDiarizer:
    """Run pyannote diarization and assign canonical labels to transcript segments."""

    def __init__(
        self,
        *,
        model_name: str = DEFAULT_PYANNOTE_MODEL,
        hf_token: str | None,
        model_cache_dir: str = DEFAULT_MODEL_CACHE_DIR,
        pipeline_factory: PipelineFactory | None = None,
    ) -> None:
        self._model_name = model_name
        self._hf_token = hf_token
        self._model_cache_dir = model_cache_dir
        self._pipeline_factory = pipeline_factory or default_pipeline_factory
        self._pipeline: PyannotePipelineLike | None = None

    def diarize(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        transcript_segments: Sequence[TranscriptSegmentDraft],
    ) -> list[TranscriptSegmentDraft]:
        if not transcript_segments:
            raise DiarizationFailed("diarization requires at least one transcript segment")
        if not normalized_path.is_file():
            raise DiarizationFailed(
                f"normalized audio is missing for meeting {meeting.id}: {normalized_path}"
            )

        pipeline = self._load_pipeline()
        try:
            annotation = pipeline(str(normalized_path))
            diarization_segments = _segments_from_pyannote_annotation(annotation)
        except DiarizationFailed:
            raise
        except Exception as error:
            raise DiarizationFailed(str(error) or error.__class__.__name__) from error

        return assign_speakers(transcript_segments, diarization_segments)

    def preload_pipeline(self) -> None:
        self._load_pipeline()

    def _load_pipeline(self) -> PyannotePipelineLike:
        if self._pipeline is None:
            if not self._hf_token:
                raise DiarizationFailed(
                    "HuggingFace token is required for pyannote diarization",
                    config_missing=True,
                )
            try:
                self._pipeline = self._pipeline_factory(
                    self._model_name,
                    use_auth_token=self._hf_token,
                    cache_dir=self._model_cache_dir,
                )
            except DiarizationFailed:
                raise
            except Exception as error:
                raise DiarizationFailed(str(error) or error.__class__.__name__) from error
        return self._pipeline


def assign_speakers(
    transcript_segments: Sequence[TranscriptSegmentDraft],
    diarization_segments: Sequence[DiarizationSegmentDraft],
    *,
    gap_tolerance_seconds: float = DEFAULT_GAP_TOLERANCE_SECONDS,
) -> list[TranscriptSegmentDraft]:
    """Assign canonical SPEAKER_NN labels to transcript segments by overlap voting.

    Transcript timing, text, and order are preserved. Diarizer-provided labels are
    canonicalized by deterministic first-seen order after sorting intervals by time.
    """

    if not transcript_segments:
        raise DiarizationFailed("diarization requires at least one transcript segment")
    if not diarization_segments:
        raise DiarizationFailed("diarization requires at least one diarization segment")

    _validate_transcript_segments(transcript_segments)
    usable_diarization_segments = _usable_diarization_segments(diarization_segments)
    if not usable_diarization_segments:
        raise DiarizationFailed("no usable diarization segments were produced")

    canonical_labels = _canonical_label_map(usable_diarization_segments)
    assigned: list[TranscriptSegmentDraft] = []
    for segment in transcript_segments:
        speaker_label = _speaker_for_segment(
            segment,
            usable_diarization_segments,
            canonical_labels,
            gap_tolerance_seconds=gap_tolerance_seconds,
        )
        assigned.append(replace(segment, speaker_label=speaker_label))
    return assigned


def default_pipeline_factory(*args: Any, **kwargs: Any) -> PyannotePipelineLike:
    """Import pyannote only when the first diarization actually runs."""

    try:
        from pyannote.audio import Pipeline
    except ImportError as error:
        raise DiarizationFailed(
            "Required Python package is missing: pyannote.audio",
            config_missing=True,
        ) from error
    _patch_pyannote_hf_hub_download_auth_keyword()
    _patch_torch_safe_globals_for_pyannote_checkpoints()
    return Pipeline.from_pretrained(*args, **kwargs)


def _patch_torch_safe_globals_for_pyannote_checkpoints() -> None:
    """Allow trusted pyannote metadata under PyTorch's safe default loader.

    PyTorch 2.6 changed ``torch.load`` to default to ``weights_only=True``.
    Some trusted pyannote checkpoints contain metadata objects that are not
    allowlisted by default and otherwise fail before diarization can start.
    """

    try:
        import torch
    except ImportError as error:
        raise DiarizationFailed(
            "Required Python package is missing: torch",
            config_missing=True,
        ) from error

    add_safe_globals = getattr(torch.serialization, "add_safe_globals", None)
    if add_safe_globals is None:
        return

    safe_globals: list[type[Any]] = []
    torch_version = getattr(torch, "torch_version", None)
    torch_version_type = getattr(torch_version, "TorchVersion", None)
    if torch_version_type is not None:
        safe_globals.append(torch_version_type)

    try:
        task_module = importlib.import_module("pyannote.audio.core.task")
    except ImportError:
        task_module = None
    if task_module is not None:
        for type_name in ("Specifications", "Problem", "Resolution"):
            safe_global = getattr(task_module, type_name, None)
            if safe_global is not None:
                safe_globals.append(safe_global)

    if not safe_globals:
        return

    # Keep this allowlist intentionally narrow: these are Torch/pyannote metadata
    # types in trusted model checkpoints, not a generic pickle bypass.
    add_safe_globals(safe_globals)


def _patch_pyannote_hf_hub_download_auth_keyword() -> None:
    """Adapt pyannote.audio 3.x to modern huggingface_hub auth kwargs.

    pyannote.audio 3.x still passes ``use_auth_token`` to module-level
    ``hf_hub_download`` references. Recent huggingface_hub versions renamed that
    keyword to ``token``, which otherwise raises before the model can load.
    """

    for module_name in (
        "pyannote.audio.core.pipeline",
        "pyannote.audio.core.model",
        "pyannote.audio.pipelines.speaker_verification",
    ):
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        download = getattr(module, "hf_hub_download", None)
        if download is None:
            continue
        setattr(
            module,
            "hf_hub_download",
            _hf_hub_download_with_pyannote_auth_keyword(download),
        )


def _hf_hub_download_with_pyannote_auth_keyword(
    download: Callable[..., Any],
) -> Callable[..., Any]:
    if getattr(download, "__slusko_pyannote_auth_compat__", False):
        return download

    try:
        parameters = inspect.signature(download).parameters
    except (TypeError, ValueError):
        return download

    if "use_auth_token" in parameters or "token" not in parameters:
        return download

    @wraps(download)
    def compatible_download(*args: Any, **kwargs: Any) -> Any:
        use_auth_token = kwargs.pop("use_auth_token", None)
        if use_auth_token is not None and "token" not in kwargs:
            kwargs["token"] = use_auth_token
        return download(*args, **kwargs)

    compatible_download.__slusko_pyannote_auth_compat__ = True  # type: ignore[attr-defined]
    return compatible_download


def _segments_from_pyannote_annotation(
    annotation: PyannoteAnnotation,
) -> list[DiarizationSegmentDraft]:
    segments: list[DiarizationSegmentDraft] = []
    for turn, _track, speaker_label in annotation.itertracks(yield_label=True):
        segments.append(
            DiarizationSegmentDraft(
                start_seconds=float(turn.start),
                end_seconds=float(turn.end),
                speaker_label=str(speaker_label),
            )
        )
    return segments


def _validate_transcript_segments(
    transcript_segments: Sequence[TranscriptSegmentDraft],
) -> None:
    for segment in transcript_segments:
        if not _is_valid_interval(segment.start_seconds, segment.end_seconds):
            raise DiarizationFailed(
                "invalid transcript segment timing: "
                f"{segment.start_seconds!r}..{segment.end_seconds!r}"
            )


def _usable_diarization_segments(
    segments: Sequence[DiarizationSegmentDraft],
) -> list[DiarizationSegmentDraft]:
    usable = [
        segment
        for segment in segments
        if _is_valid_interval(segment.start_seconds, segment.end_seconds)
        and segment.speaker_label.strip()
    ]
    return sorted(
        usable,
        key=lambda segment: (
            float(segment.start_seconds),
            float(segment.end_seconds),
            segment.speaker_label,
        ),
    )


def _canonical_label_map(
    diarization_segments: Sequence[DiarizationSegmentDraft],
) -> dict[str, str]:
    first_start_by_raw_label: dict[str, float] = {}
    for segment in diarization_segments:
        first_start_by_raw_label[segment.speaker_label] = min(
            first_start_by_raw_label.get(segment.speaker_label, math.inf),
            float(segment.start_seconds),
        )

    return {
        raw_label: f"SPEAKER_{index:02d}"
        for index, raw_label in enumerate(
            sorted(
                first_start_by_raw_label,
                key=lambda raw_label: (first_start_by_raw_label[raw_label], raw_label),
            )
        )
    }


def _speaker_for_segment(
    transcript_segment: TranscriptSegmentDraft,
    diarization_segments: Sequence[DiarizationSegmentDraft],
    canonical_labels: dict[str, str],
    *,
    gap_tolerance_seconds: float,
) -> str:
    votes: dict[str, float] = {}
    earliest_overlap_start: dict[str, float] = {}

    for diarization_segment in diarization_segments:
        overlap = _overlap_duration(transcript_segment, diarization_segment)
        if overlap <= 0:
            continue

        canonical_label = canonical_labels[diarization_segment.speaker_label]
        votes[canonical_label] = votes.get(canonical_label, 0.0) + overlap
        overlap_start = max(
            float(transcript_segment.start_seconds),
            float(diarization_segment.start_seconds),
        )
        earliest_overlap_start[canonical_label] = min(
            earliest_overlap_start.get(canonical_label, math.inf),
            overlap_start,
        )

    if votes:
        return min(
            votes,
            key=lambda speaker_label: (
                -votes[speaker_label],
                earliest_overlap_start[speaker_label],
                speaker_label,
            ),
        )

    nearest = _nearest_diarization_segment(
        transcript_segment, diarization_segments, canonical_labels
    )
    if nearest is not None:
        distance, speaker_label = nearest
        if distance <= max(0.0, gap_tolerance_seconds):
            return speaker_label
    return FALLBACK_SPEAKER_LABEL


def _nearest_diarization_segment(
    transcript_segment: TranscriptSegmentDraft,
    diarization_segments: Sequence[DiarizationSegmentDraft],
    canonical_labels: dict[str, str],
) -> tuple[float, str] | None:
    if not diarization_segments:
        return None

    return min(
        (
            (
                _temporal_distance(transcript_segment, diarization_segment),
                canonical_labels[diarization_segment.speaker_label],
            )
            for diarization_segment in diarization_segments
        ),
        key=lambda item: (item[0], item[1]),
    )


def _overlap_duration(
    transcript_segment: TranscriptSegmentDraft,
    diarization_segment: DiarizationSegmentDraft,
) -> float:
    return max(
        0.0,
        min(
            float(transcript_segment.end_seconds),
            float(diarization_segment.end_seconds),
        )
        - max(
            float(transcript_segment.start_seconds),
            float(diarization_segment.start_seconds),
        ),
    )


def _temporal_distance(
    transcript_segment: TranscriptSegmentDraft,
    diarization_segment: DiarizationSegmentDraft,
) -> float:
    transcript_start = float(transcript_segment.start_seconds)
    transcript_end = float(transcript_segment.end_seconds)
    diarization_start = float(diarization_segment.start_seconds)
    diarization_end = float(diarization_segment.end_seconds)

    if transcript_end <= diarization_start:
        return diarization_start - transcript_end
    if diarization_end <= transcript_start:
        return transcript_start - diarization_end
    return 0.0


def _is_valid_interval(start: float, end: float) -> bool:
    try:
        start_value = float(start)
        end_value = float(end)
    except (TypeError, ValueError):
        return False
    return (
        math.isfinite(start_value)
        and math.isfinite(end_value)
        and end_value > start_value
    )
