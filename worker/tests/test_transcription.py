from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import pytest

from slusko_worker.db.models import MeetingStatus, QueuedMeeting
from slusko_worker.pipeline.errors import TranscriptionEmpty, TranscriptionFailed
from slusko_worker.pipeline.transcription import WhisperTranscriber


MEETING_ID = UUID("00000000-0000-0000-0000-000000000001")


def queued_meeting() -> QueuedMeeting:
    return QueuedMeeting(
        id=MEETING_ID,
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


@dataclass(frozen=True)
class FakeSegment:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class FakeInfo:
    duration: float | None


class ExplodingSegments:
    def __iter__(self) -> object:
        raise RuntimeError("decode failed during iteration")


class FakeModel:
    def __init__(self, segments: object, info: FakeInfo) -> None:
        self.segments = segments
        self.info = info
        self.calls: list[tuple[str, dict[str, object]]] = []

    def transcribe(self, audio: str, **kwargs: object) -> tuple[list[FakeSegment], FakeInfo]:
        self.calls.append((audio, kwargs))
        return self.segments, self.info


class RecordingModelFactory:
    def __init__(self, model: FakeModel, *, error: Exception | None = None) -> None:
        self.model = model
        self.error = error
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __call__(self, *args: object, **kwargs: object) -> FakeModel:
        self.calls.append((args, kwargs))
        if self.error is not None:
            raise self.error
        return self.model


def normalized_file(tmp_path: Path) -> Path:
    path = tmp_path / "normalized.wav"
    path.write_bytes(b"wav")
    return path


def test_transcriber_loads_whisper_model_once_and_uses_domain_call_options(
    tmp_path: Path,
) -> None:
    model = FakeModel(
        [FakeSegment(0.0, 4.0, "This is a useful transcript with enough words here")],
        FakeInfo(duration=10.0),
    )
    factory = RecordingModelFactory(model)
    transcriber = WhisperTranscriber(
        whisper_model="large-v3",
        whisper_device="auto",
        whisper_compute_type="auto",
        model_cache_dir="/models",
        model_factory=factory,
    )
    path = normalized_file(tmp_path)

    first = transcriber.transcribe(
        meeting=queued_meeting(), normalized_path=path, progress=lambda _progress: None
    )
    second = transcriber.transcribe(
        meeting=queued_meeting(), normalized_path=path, progress=lambda _progress: None
    )

    assert len(factory.calls) == 1
    assert factory.calls[0] == (
        ("large-v3",),
        {"device": "auto", "compute_type": "auto", "download_root": "/models"},
    )
    assert model.calls == [
        (
            str(path),
            {"language": None, "condition_on_previous_text": False},
        ),
        (
            str(path),
            {"language": None, "condition_on_previous_text": False},
        ),
    ]
    assert first == second


def test_transcriber_trims_blank_segments_and_uses_placeholder_speaker_label(
    tmp_path: Path,
) -> None:
    model = FakeModel(
        [
            FakeSegment(0.0, 1.0, "   "),
            FakeSegment(1.0, 3.5, "  Hello team, this transcript has enough useful words today  "),
        ],
        FakeInfo(duration=5.0),
    )
    transcriber = WhisperTranscriber(model_factory=RecordingModelFactory(model))

    segments = transcriber.transcribe(
        meeting=queued_meeting(),
        normalized_path=normalized_file(tmp_path),
        progress=lambda _progress: None,
    )

    assert len(segments) == 1
    assert segments[0].start_seconds == 1.0
    assert segments[0].end_seconds == 3.5
    assert segments[0].speaker_label == "SPEAKER_00"
    assert segments[0].text == "Hello team, this transcript has enough useful words today"


@pytest.mark.parametrize(
    "segments",
    [
        [],
        [FakeSegment(0.0, 1.5, "Thank you")],
    ],
)
def test_transcriber_raises_distinct_empty_error_for_no_speech(
    tmp_path: Path, segments: list[FakeSegment]
) -> None:
    model = FakeModel(segments, FakeInfo(duration=5.0))
    transcriber = WhisperTranscriber(model_factory=RecordingModelFactory(model))

    with pytest.raises(TranscriptionEmpty):
        transcriber.transcribe(
            meeting=queued_meeting(),
            normalized_path=normalized_file(tmp_path),
            progress=lambda _progress: None,
        )


def test_transcriber_throttles_progress_and_never_emits_terminal_100(
    tmp_path: Path,
) -> None:
    model = FakeModel(
        [
            FakeSegment(0.0, 10.0, "one two three four five"),
            FakeSegment(10.0, 30.0, "six seven eight nine ten"),
            FakeSegment(30.0, 100.0, "eleven twelve thirteen fourteen fifteen"),
        ],
        FakeInfo(duration=100.0),
    )
    updates: list[int] = []
    transcriber = WhisperTranscriber(
        model_factory=RecordingModelFactory(model),
        progress_min_delta=25,
        progress_min_interval_seconds=999,
        clock=lambda: 0.0,
    )

    transcriber.transcribe(
        meeting=queued_meeting(),
        normalized_path=normalized_file(tmp_path),
        progress=updates.append,
    )

    assert updates == [30, 99]


def test_transcriber_progress_can_emit_after_min_interval_even_below_delta(
    tmp_path: Path,
) -> None:
    model = FakeModel(
        [
            FakeSegment(0.0, 10.0, "one two three four five"),
            FakeSegment(10.0, 20.0, "six seven eight nine ten"),
            FakeSegment(20.0, 30.0, "eleven twelve thirteen fourteen fifteen"),
        ],
        FakeInfo(duration=100.0),
    )
    times = iter([0.0, 1.0, 6.0, 7.0])
    updates: list[int] = []
    transcriber = WhisperTranscriber(
        model_factory=RecordingModelFactory(model),
        progress_min_delta=50,
        progress_min_interval_seconds=5,
        clock=lambda: next(times),
    )

    transcriber.transcribe(
        meeting=queued_meeting(),
        normalized_path=normalized_file(tmp_path),
        progress=updates.append,
    )

    assert updates == [20]


def test_transcriber_wraps_lazy_segment_iteration_errors_as_transcription_failed(
    tmp_path: Path,
) -> None:
    model = FakeModel(ExplodingSegments(), FakeInfo(duration=5.0))
    transcriber = WhisperTranscriber(model_factory=RecordingModelFactory(model))

    with pytest.raises(TranscriptionFailed, match="decode failed during iteration"):
        transcriber.transcribe(
            meeting=queued_meeting(),
            normalized_path=normalized_file(tmp_path),
            progress=lambda _progress: None,
        )


def test_transcriber_wraps_missing_audio_or_model_errors_as_transcription_failed(
    tmp_path: Path,
) -> None:
    missing_path = tmp_path / "missing.wav"
    transcriber = WhisperTranscriber(
        model_factory=RecordingModelFactory(
            FakeModel([], FakeInfo(duration=None)), error=RuntimeError("download failed")
        )
    )

    with pytest.raises(TranscriptionFailed, match="normalized audio is missing"):
        transcriber.transcribe(
            meeting=queued_meeting(),
            normalized_path=missing_path,
            progress=lambda _progress: None,
        )

    with pytest.raises(TranscriptionFailed, match="download failed"):
        transcriber.transcribe(
            meeting=queued_meeting(),
            normalized_path=normalized_file(tmp_path),
            progress=lambda _progress: None,
        )
