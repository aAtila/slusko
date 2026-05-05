from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from slusko_worker.db.models import MeetingStatus, QueuedMeeting
from slusko_worker.pipeline.errors import NormalizationFailed
from slusko_worker.pipeline.normalization import (
    AudioNormalizer,
    build_ffmpeg_args,
    parse_ffprobe_duration_seconds,
)


def test_build_ffmpeg_args_matches_domain_contract() -> None:
    input_path = Path("/data/meetings/meeting-1/original.m4a")
    output_path = Path("/data/meetings/meeting-1/normalized.wav")

    assert build_ffmpeg_args(input_path=input_path, output_path=output_path) == [
        "ffmpeg",
        "-i",
        "/data/meetings/meeting-1/original.m4a",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        "/data/meetings/meeting-1/normalized.wav",
    ]


def test_parse_ffprobe_duration_ceilings_positive_fractional_seconds() -> None:
    assert parse_ffprobe_duration_seconds("0.125\n") == 1
    assert parse_ffprobe_duration_seconds("41.01") == 42
    assert parse_ffprobe_duration_seconds("42.0") == 42


def test_parse_ffprobe_duration_rejects_non_finite_values() -> None:
    for output in ("inf", "nan"):
        try:
            parse_ffprobe_duration_seconds(output)
        except ValueError as error:
            assert "finite" in str(error)
        else:
            raise AssertionError(f"expected {output!r} to be rejected")


@dataclass(frozen=True)
class FakeCompletedProcess:
    stdout: str = ""
    stderr: str = ""


class ArtifactLifecycleRunner:
    def __init__(self, *, partial_path: Path, transient_path: Path) -> None:
        self.partial_path = partial_path
        self.transient_path = transient_path
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], **_kwargs: object) -> FakeCompletedProcess:
        self.calls.append(args)
        if args[0] == "ffmpeg":
            assert not self.partial_path.exists()
            assert not self.transient_path.exists()
            Path(args[-1]).write_bytes(b"new normalized wav")
            return FakeCompletedProcess()
        if args[0] == "ffprobe":
            return FakeCompletedProcess(stdout="1.1\n")
        raise AssertionError(f"unexpected command: {args}")


def missing_binary_runner(args: list[str], **_kwargs: object) -> FakeCompletedProcess:
    raise FileNotFoundError(args[0])


def test_missing_ffmpeg_binary_is_configuration_failure(tmp_path: Path) -> None:
    meeting_id = UUID("00000000-0000-0000-0000-000000000124")
    meeting_dir = tmp_path / str(meeting_id)
    meeting_dir.mkdir()
    (meeting_dir / "original.m4a").write_bytes(b"original audio")
    normalizer = AudioNormalizer(meetings_dir=tmp_path, run=missing_binary_runner)

    try:
        normalizer.normalize(
            QueuedMeeting(
                id=meeting_id,
                status=MeetingStatus.PENDING,
                resume_from_stage=None,
                transcription_progress=None,
                error_kind=None,
                error_message=None,
                failed_at_stage=None,
            )
        )
    except NormalizationFailed as error:
        assert error.config_missing is True
        assert "ffmpeg" in str(error)
    else:
        raise AssertionError("expected missing ffmpeg to fail normalization")


class ProbeOnlyRunner:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], **_kwargs: object) -> FakeCompletedProcess:
        self.calls.append(args)
        if args[0] == "ffprobe":
            return FakeCompletedProcess(stdout="3.2\n")
        raise AssertionError(f"unexpected command: {args}")


def test_pending_meeting_without_original_does_not_reuse_stray_normalized_artifact(
    tmp_path: Path,
) -> None:
    meeting_id = UUID("00000000-0000-0000-0000-000000000126")
    meeting_dir = tmp_path / str(meeting_id)
    meeting_dir.mkdir()
    (meeting_dir / "normalized.wav").write_bytes(b"stray normalized")
    runner = ProbeOnlyRunner()
    normalizer = AudioNormalizer(meetings_dir=tmp_path, run=runner)

    try:
        normalizer.normalize(
            QueuedMeeting(
                id=meeting_id,
                status=MeetingStatus.PENDING,
                resume_from_stage=None,
                transcription_progress=None,
                error_kind=None,
                error_message=None,
                failed_at_stage=None,
            )
        )
    except NormalizationFailed as error:
        assert "No supported original audio file" in str(error)
    else:
        raise AssertionError("expected pending meeting without original audio to fail")

    assert runner.calls == []


def test_normalize_reentry_uses_existing_final_artifact_when_original_was_already_deleted(
    tmp_path: Path,
) -> None:
    meeting_id = UUID("00000000-0000-0000-0000-000000000125")
    meeting_dir = tmp_path / str(meeting_id)
    meeting_dir.mkdir()
    final_path = meeting_dir / "normalized.wav"
    partial_path = meeting_dir / "normalized.wav.partial"
    final_path.write_bytes(b"already normalized")
    partial_path.write_bytes(b"stale partial")
    runner = ProbeOnlyRunner()
    normalizer = AudioNormalizer(meetings_dir=tmp_path, run=runner)

    result = normalizer.normalize(
        QueuedMeeting(
            id=meeting_id,
            status=MeetingStatus.NORMALIZING,
            resume_from_stage=None,
            transcription_progress=None,
            error_kind=None,
            error_message=None,
            failed_at_stage=None,
        )
    )

    assert result.duration_seconds == 4
    assert final_path.read_bytes() == b"already normalized"
    assert not partial_path.exists()
    assert len(runner.calls) == 1
    assert runner.calls[0][0] == "ffprobe"


def test_normalize_reentry_replaces_stale_artifacts_and_deletes_original_after_success(
    tmp_path: Path,
) -> None:
    meeting_id = UUID("00000000-0000-0000-0000-000000000123")
    meeting_dir = tmp_path / str(meeting_id)
    meeting_dir.mkdir()
    original_path = meeting_dir / "original.m4a"
    partial_path = meeting_dir / "normalized.wav.partial"
    final_path = meeting_dir / "normalized.wav"
    transient_path = meeting_dir / "normalized.partial.wav"
    original_path.write_bytes(b"original audio")
    partial_path.write_bytes(b"stale partial")
    transient_path.write_bytes(b"stale transient")
    final_path.write_bytes(b"stale final")
    runner = ArtifactLifecycleRunner(
        partial_path=partial_path, transient_path=transient_path
    )
    normalizer = AudioNormalizer(meetings_dir=tmp_path, run=runner)

    result = normalizer.normalize(
        QueuedMeeting(
            id=meeting_id,
            status=MeetingStatus.NORMALIZING,
            resume_from_stage=None,
            transcription_progress=None,
            error_kind=None,
            error_message=None,
            failed_at_stage=None,
        )
    )

    assert result.duration_seconds == 2
    assert final_path.read_bytes() == b"new normalized wav"
    assert not partial_path.exists()
    assert not original_path.exists()
    assert not transient_path.exists()
    assert runner.calls[0] == build_ffmpeg_args(
        input_path=original_path, output_path=transient_path
    )
    assert runner.calls[1][0] == "ffprobe"
    assert runner.calls[1][-1] == str(final_path)
