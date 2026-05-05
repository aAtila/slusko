"""Audio normalization stage."""

from __future__ import annotations

import math
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from slusko_worker.db.models import MeetingStatus, QueuedMeeting
from slusko_worker.pipeline.errors import NormalizationFailed

SUPPORTED_ORIGINAL_EXTENSIONS = (".mp3", ".m4a", ".wav", ".mp4")
NORMALIZED_FILENAME = "normalized.wav"
PARTIAL_NORMALIZED_FILENAME = "normalized.wav.partial"
TRANSIENT_NORMALIZED_FILENAME = "normalized.partial.wav"


class CompletedProcessLike(Protocol):
    stdout: str
    stderr: str


class CommandRunner(Protocol):
    def __call__(self, args: list[str], **kwargs: object) -> CompletedProcessLike: ...


@dataclass(frozen=True, slots=True)
class NormalizationResult:
    duration_seconds: int
    normalized_path: Path


class AudioNormalizer:
    """Normalize a meeting's uploaded audio into an idempotent WAV artifact."""

    def __init__(
        self, *, meetings_dir: str | Path, run: CommandRunner | None = None
    ) -> None:
        self._meetings_dir = Path(meetings_dir)
        self._run = run if run is not None else subprocess.run

    def normalize(self, meeting: QueuedMeeting) -> NormalizationResult:
        meeting_dir = self._meetings_dir / str(meeting.id)
        partial_path = meeting_dir / PARTIAL_NORMALIZED_FILENAME
        transient_path = meeting_dir / TRANSIENT_NORMALIZED_FILENAME
        normalized_path = meeting_dir / NORMALIZED_FILENAME

        partial_path.unlink(missing_ok=True)
        transient_path.unlink(missing_ok=True)

        allow_final_artifact_reentry = (
            meeting.status == MeetingStatus.NORMALIZING and normalized_path.is_file()
        )
        original_path = find_original_audio(
            meeting_dir,
            allow_missing_when_normalized_exists=allow_final_artifact_reentry,
        )
        if original_path is None:
            duration_seconds = probe_duration_seconds(self._run, normalized_path)
            return NormalizationResult(
                duration_seconds=duration_seconds, normalized_path=normalized_path
            )

        run_command(
            self._run,
            build_ffmpeg_args(input_path=original_path, output_path=transient_path),
            "ffmpeg",
        )

        if not transient_path.is_file():
            raise NormalizationFailed(
                "ffmpeg completed but did not write normalized.partial.wav"
            )

        transient_path.replace(partial_path)

        if not partial_path.is_file():
            raise NormalizationFailed("normalized.wav.partial was not created")

        partial_path.replace(normalized_path)

        if not normalized_path.is_file():
            raise NormalizationFailed("normalized.wav was not created")

        duration_seconds = probe_duration_seconds(self._run, normalized_path)
        delete_original_audio_files(meeting_dir)
        return NormalizationResult(
            duration_seconds=duration_seconds, normalized_path=normalized_path
        )


def find_original_audio(
    meeting_dir: Path, *, allow_missing_when_normalized_exists: bool = False
) -> Path | None:
    originals = [
        meeting_dir / f"original{extension}"
        for extension in SUPPORTED_ORIGINAL_EXTENSIONS
    ]
    existing_originals = [path for path in originals if path.is_file()]
    if not existing_originals:
        if allow_missing_when_normalized_exists:
            return None
        raise NormalizationFailed(
            f"No supported original audio file found in {meeting_dir}; expected original.mp3, original.m4a, original.wav, or original.mp4"
        )
    if len(existing_originals) > 1:
        names = ", ".join(path.name for path in existing_originals)
        raise NormalizationFailed(
            f"Multiple original audio files found in {meeting_dir}: {names}"
        )
    return existing_originals[0]


def delete_original_audio_files(meeting_dir: Path) -> None:
    for extension in SUPPORTED_ORIGINAL_EXTENSIONS:
        (meeting_dir / f"original{extension}").unlink(missing_ok=True)


def run_command(
    run: CommandRunner, args: list[str], binary_name: str
) -> CompletedProcessLike:
    try:
        return run(args, check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise NormalizationFailed(
            f"Required binary is missing: {binary_name}", config_missing=True
        ) from error
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or "").strip()
        detail = f": {stderr}" if stderr else ""
        raise NormalizationFailed(f"{binary_name} failed{detail}") from error


def probe_duration_seconds(run: CommandRunner, path: Path) -> int:
    completed = run_command(run, build_ffprobe_args(path), "ffprobe")
    try:
        return parse_ffprobe_duration_seconds(completed.stdout)
    except (OverflowError, ValueError) as error:
        raise NormalizationFailed(
            f"ffprobe returned an invalid duration for {path}: {completed.stdout!r}"
        ) from error


def build_ffprobe_args(path: Path) -> list[str]:
    return [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]


def parse_ffprobe_duration_seconds(output: str) -> int:
    """Parse ffprobe duration output into the persisted non-negative integer seconds."""

    duration = float(output.strip())
    if not math.isfinite(duration):
        raise ValueError("ffprobe duration must be finite")
    if duration < 0:
        raise ValueError("ffprobe duration cannot be negative")
    return math.ceil(duration)


def build_ffmpeg_args(*, input_path: Path, output_path: Path) -> list[str]:
    """Return the canonical domain ffmpeg invocation for normalization."""

    return [
        "ffmpeg",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        str(output_path),
    ]
