from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from uuid import UUID

import pytest

from slusko_worker.db.models import (
    DiarizationSegmentDraft,
    ErrorKind,
    MeetingStatus,
    QueuedMeeting,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline.diarization import (
    PyannoteDiarizer,
    _hf_hub_download_with_pyannote_auth_keyword,
    _patch_pyannote_hf_hub_download_auth_keyword,
    assign_speakers,
)
from slusko_worker.pipeline.errors import DiarizationFailed


MEETING_ID = UUID("00000000-0000-0000-0000-000000000009")


def queued_meeting() -> QueuedMeeting:
    return QueuedMeeting(
        id=MEETING_ID,
        status=MeetingStatus.DIARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


def transcript(
    start: float,
    end: float,
    text: str,
    speaker_label: str = "SPEAKER_00",
) -> TranscriptSegmentDraft:
    return TranscriptSegmentDraft(
        start_seconds=start,
        end_seconds=end,
        speaker_label=speaker_label,
        text=text,
    )


def diarization(
    start: float,
    end: float,
    speaker_label: str,
) -> DiarizationSegmentDraft:
    return DiarizationSegmentDraft(
        start_seconds=start,
        end_seconds=end,
        speaker_label=speaker_label,
    )


def test_assign_speakers_votes_by_overlap_and_canonicalizes_labels() -> None:
    segments = [
        transcript(0.0, 4.0, "Opening from the first speaker"),
        transcript(4.0, 8.0, "Reply from the second speaker"),
        transcript(8.0, 10.0, "Back to the first speaker"),
    ]
    diarized = [
        diarization(0.0, 4.1, "bob"),
        diarization(4.1, 8.0, "alice"),
        diarization(8.0, 10.0, "bob"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert [segment.speaker_label for segment in assigned] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_00",
    ]
    assert [(segment.start_seconds, segment.end_seconds, segment.text) for segment in assigned] == [
        (segment.start_seconds, segment.end_seconds, segment.text) for segment in segments
    ]


def test_assign_speakers_uses_overlap_not_segment_start_for_mixed_segments() -> None:
    segments = [transcript(0.0, 10.0, "Most of this segment belongs to B")]
    diarized = [
        diarization(0.0, 3.0, "speaker-a"),
        diarization(3.0, 10.0, "speaker-b"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert assigned[0].speaker_label == "SPEAKER_01"


def test_assign_speakers_handles_boundaries_as_half_open_intervals() -> None:
    segments = [
        transcript(0.0, 1.0, "First exact boundary"),
        transcript(1.0, 2.0, "Second exact boundary"),
    ]
    diarized = [
        diarization(0.0, 1.0, "left"),
        diarization(1.0, 2.0, "right"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert [segment.speaker_label for segment in assigned] == ["SPEAKER_00", "SPEAKER_01"]


def test_assign_speakers_uses_nearest_speaker_for_small_gaps_and_fallback_for_large_gaps() -> None:
    segments = [
        transcript(1.1, 1.4, "Short pause after the first speaker"),
        transcript(9.0, 10.0, "Transcript island far from diarized speech"),
    ]
    diarized = [
        diarization(0.0, 1.0, "first"),
        diarization(2.0, 3.0, "second"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert [segment.speaker_label for segment in assigned] == ["SPEAKER_00", "SPEAKER_00"]


def test_assign_speakers_tie_breaks_by_earliest_overlap_then_canonical_label() -> None:
    segments = [
        transcript(0.0, 2.0, "Equal split chooses earlier overlapping speaker"),
        transcript(3.0, 4.0, "Duplicated equal overlaps choose canonical label"),
    ]
    diarized = [
        diarization(0.0, 1.0, "first"),
        diarization(1.0, 2.0, "second"),
        diarization(3.0, 4.0, "second"),
        diarization(3.0, 4.0, "first"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert [segment.speaker_label for segment in assigned] == ["SPEAKER_00", "SPEAKER_00"]


def test_assign_speakers_canonicalizes_simultaneous_first_seen_by_raw_label() -> None:
    segments = [
        transcript(0.0, 0.4, "Speaker A starts at the same time"),
        transcript(0.4, 1.0, "Speaker B has the longer first turn"),
    ]
    diarized = [
        diarization(0.0, 1.0, "speaker-b"),
        diarization(0.0, 0.4, "speaker-a"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert [segment.speaker_label for segment in assigned] == ["SPEAKER_00", "SPEAKER_01"]


def test_assign_speakers_keeps_short_back_and_forth_deterministic() -> None:
    segments = [
        transcript(0.00, 0.30, "A"),
        transcript(0.30, 0.60, "B"),
        transcript(0.60, 0.90, "A again"),
        transcript(0.90, 1.20, "B again"),
    ]
    diarized = [
        diarization(0.00, 0.30, "raw-a"),
        diarization(0.30, 0.60, "raw-b"),
        diarization(0.60, 0.90, "raw-a"),
        diarization(0.90, 1.20, "raw-b"),
    ]

    assigned = assign_speakers(segments, diarized)

    assert [segment.speaker_label for segment in assigned] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_00",
        "SPEAKER_01",
    ]


@pytest.mark.parametrize(
    ("segments", "diarized", "message"),
    [
        ([], [diarization(0.0, 1.0, "a")], "at least one transcript segment"),
        ([transcript(0.0, 1.0, "hello")], [], "at least one diarization segment"),
        ([transcript(1.0, 1.0, "bad")], [diarization(0.0, 1.0, "a")], "invalid transcript segment"),
        ([transcript(0.0, 1.0, "hello")], [diarization(1.0, 1.0, "a")], "no usable diarization segments"),
    ],
)
def test_assign_speakers_rejects_empty_or_invalid_inputs(
    segments: list[TranscriptSegmentDraft],
    diarized: list[DiarizationSegmentDraft],
    message: str,
) -> None:
    with pytest.raises(DiarizationFailed, match=message):
        assign_speakers(segments, diarized)


@dataclass(frozen=True)
class FakeTurn:
    start: float
    end: float


class FakeAnnotation:
    def __init__(self, rows: list[tuple[FakeTurn, str, str]]) -> None:
        self.rows = rows

    def itertracks(self, *, yield_label: bool = False) -> object:
        assert yield_label is True
        return iter(self.rows)


class FakePipeline:
    def __init__(self, annotation: FakeAnnotation | None = None, *, error: Exception | None = None) -> None:
        self.annotation = annotation or FakeAnnotation([])
        self.error = error
        self.calls: list[str] = []

    def __call__(self, audio: str) -> FakeAnnotation:
        self.calls.append(audio)
        if self.error is not None:
            raise self.error
        return self.annotation


class RecordingPipelineFactory:
    def __init__(self, pipeline: FakePipeline, *, error: Exception | None = None) -> None:
        self.pipeline = pipeline
        self.error = error
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __call__(self, *args: object, **kwargs: object) -> FakePipeline:
        self.calls.append((args, kwargs))
        if self.error is not None:
            raise self.error
        return self.pipeline


def normalized_file(tmp_path: Path) -> Path:
    path = tmp_path / "normalized.wav"
    path.write_bytes(b"wav")
    return path


def test_pyannote_diarizer_loads_pipeline_once_and_assigns_speakers(tmp_path: Path) -> None:
    pipeline = FakePipeline(
        FakeAnnotation(
            [
                (FakeTurn(0.0, 1.0), "track-a", "raw-a"),
                (FakeTurn(1.0, 2.0), "track-b", "raw-b"),
            ]
        )
    )
    factory = RecordingPipelineFactory(pipeline)
    diarizer = PyannoteDiarizer(
        model_name="pyannote/test",
        hf_token="hf_test",
        model_cache_dir="/models",
        pipeline_factory=factory,
    )
    path = normalized_file(tmp_path)
    segments = [transcript(0.0, 1.0, "A"), transcript(1.0, 2.0, "B")]

    first = diarizer.diarize(
        meeting=queued_meeting(), normalized_path=path, transcript_segments=segments
    )
    second = diarizer.diarize(
        meeting=queued_meeting(), normalized_path=path, transcript_segments=segments
    )

    assert len(factory.calls) == 1
    assert factory.calls[0] == (
        ("pyannote/test",),
        {"use_auth_token": "hf_test", "cache_dir": "/models"},
    )
    assert pipeline.calls == [str(path), str(path)]
    assert [segment.speaker_label for segment in first] == ["SPEAKER_00", "SPEAKER_01"]
    assert first == second


def test_pyannote_diarizer_reports_missing_token_as_config_missing(tmp_path: Path) -> None:
    diarizer = PyannoteDiarizer(
        hf_token=None,
        pipeline_factory=RecordingPipelineFactory(FakePipeline()),
    )

    with pytest.raises(DiarizationFailed) as caught:
        diarizer.diarize(
            meeting=queued_meeting(),
            normalized_path=normalized_file(tmp_path),
            transcript_segments=[transcript(0.0, 1.0, "hello")],
        )

    failure = caught.value.to_failure()
    assert failure.error_kind == ErrorKind.CONFIG_MISSING
    assert failure.failed_at_stage == MeetingStatus.DIARIZING


def test_pyannote_diarizer_wraps_missing_audio_load_and_runtime_failures(tmp_path: Path) -> None:
    diarizer = PyannoteDiarizer(
        hf_token="hf_test",
        pipeline_factory=RecordingPipelineFactory(FakePipeline()),
    )

    with pytest.raises(DiarizationFailed, match="normalized audio is missing"):
        diarizer.diarize(
            meeting=queued_meeting(),
            normalized_path=tmp_path / "missing.wav",
            transcript_segments=[transcript(0.0, 1.0, "hello")],
        )

    load_failure = PyannoteDiarizer(
        hf_token="hf_test",
        pipeline_factory=RecordingPipelineFactory(FakePipeline(), error=RuntimeError("download failed")),
    )
    with pytest.raises(DiarizationFailed, match="download failed"):
        load_failure.diarize(
            meeting=queued_meeting(),
            normalized_path=normalized_file(tmp_path),
            transcript_segments=[transcript(0.0, 1.0, "hello")],
        )

    runtime_failure = PyannoteDiarizer(
        hf_token="hf_test",
        pipeline_factory=RecordingPipelineFactory(FakePipeline(error=RuntimeError("gpu exploded"))),
    )
    with pytest.raises(DiarizationFailed, match="gpu exploded"):
        runtime_failure.diarize(
            meeting=queued_meeting(),
            normalized_path=normalized_file(tmp_path),
            transcript_segments=[transcript(0.0, 1.0, "hello")],
        )


def test_pyannote_auth_compatibility_maps_legacy_keyword_to_modern_hub_token() -> None:
    calls: list[dict[str, object]] = []

    def modern_hf_hub_download(*, token: str | None = None) -> str | None:
        calls.append({"token": token})
        return token

    compatible_download = _hf_hub_download_with_pyannote_auth_keyword(
        modern_hf_hub_download
    )

    assert compatible_download(use_auth_token="hf_test") == "hf_test"
    assert compatible_download(use_auth_token="ignored", token="hf_override") == "hf_override"
    assert calls == [{"token": "hf_test"}, {"token": "hf_override"}]


def test_pyannote_auth_compatibility_patches_loaded_pyannote_modules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def modern_hf_hub_download(*, token: str | None = None) -> str | None:
        return token

    module = ModuleType("pyannote.audio.core.pipeline")
    module.hf_hub_download = modern_hf_hub_download  # type: ignore[attr-defined]
    monkeypatch.setitem(__import__("sys").modules, module.__name__, module)

    _patch_pyannote_hf_hub_download_auth_keyword()

    assert module.hf_hub_download(use_auth_token="hf_test") == "hf_test"  # type: ignore[attr-defined]


def test_default_pipeline_factory_maps_missing_pyannote_package_to_config_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    real_import = builtins.__import__

    def fail_pyannote_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "pyannote.audio":
            raise ImportError("no pyannote")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_pyannote_import)

    diarizer = PyannoteDiarizer(hf_token="hf_test")

    with pytest.raises(DiarizationFailed) as caught:
        diarizer._load_pipeline()

    assert caught.value.to_failure().error_kind == ErrorKind.CONFIG_MISSING
