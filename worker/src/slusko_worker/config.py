"""Runtime configuration for the Slusko worker."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    database_url: str
    meetings_dir: str = "/data/meetings"
    model_cache_dir: str = "/data/models"
    hf_home: str = "/data/models"
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    whisper_compute_type: str = "auto"
    pyannote_model: str = "pyannote/speaker-diarization-3.1"
    huggingface_token: str | None = None
    transcription_progress_min_delta: int = 5
    transcription_progress_min_interval_seconds: float = 5.0
    poll_interval_seconds: float = 300
    connect_timeout_seconds: int = 5
    tcp_keepalives: int = 1
    tcp_keepalives_idle: int = 60
    tcp_keepalives_interval: int = 30
    tcp_keepalives_count: int = 5

    @property
    def database_connect_kwargs(self) -> dict[str, int]:
        return {"connect_timeout": self.connect_timeout_seconds}

    @property
    def listener_connect_kwargs(self) -> dict[str, int | bool]:
        return {
            "autocommit": True,
            "connect_timeout": self.connect_timeout_seconds,
            "keepalives": self.tcp_keepalives,
            "keepalives_idle": self.tcp_keepalives_idle,
            "keepalives_interval": self.tcp_keepalives_interval,
            "keepalives_count": self.tcp_keepalives_count,
        }


def apply_hf_home_default(
    config: WorkerConfig, environ: dict[str, str] | None = None
) -> None:
    """Expose the computed Hugging Face cache home to libraries that read env vars."""

    env = environ if environ is not None else os.environ
    env.setdefault("HF_HOME", config.hf_home)


def load_config(environ: dict[str, str] | None = None) -> WorkerConfig:
    env = environ if environ is not None else os.environ
    database_url = env.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to start the worker")

    model_cache_dir = env.get("MODEL_CACHE_DIR", "/data/models")

    return WorkerConfig(
        database_url=database_url,
        meetings_dir=env.get("MEETINGS_DIR", "/data/meetings"),
        model_cache_dir=model_cache_dir,
        hf_home=env.get("HF_HOME", model_cache_dir),
        whisper_model=env.get("WHISPER_MODEL", "large-v3"),
        whisper_device=env.get("WHISPER_DEVICE", "auto"),
        whisper_compute_type=env.get("WHISPER_COMPUTE_TYPE", "auto"),
        pyannote_model=env.get("PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1"),
        huggingface_token=env.get("HUGGINGFACE_TOKEN") or env.get("HF_TOKEN"),
        transcription_progress_min_delta=_positive_int(
            env.get("TRANSCRIPTION_PROGRESS_MIN_DELTA"), default=5
        ),
        transcription_progress_min_interval_seconds=_non_negative_float(
            env.get("TRANSCRIPTION_PROGRESS_MIN_INTERVAL_SECONDS"), default=5.0
        ),
        poll_interval_seconds=float(env.get("QUEUE_POLL_INTERVAL_SECONDS", "300")),
        connect_timeout_seconds=int(env.get("DATABASE_CONNECT_TIMEOUT_SECONDS", "5")),
        tcp_keepalives=int(env.get("DATABASE_TCP_KEEPALIVES", "1")),
        tcp_keepalives_idle=int(env.get("DATABASE_TCP_KEEPALIVES_IDLE", "60")),
        tcp_keepalives_interval=int(env.get("DATABASE_TCP_KEEPALIVES_INTERVAL", "30")),
        tcp_keepalives_count=int(env.get("DATABASE_TCP_KEEPALIVES_COUNT", "5")),
    )


def _positive_int(value: str | None, *, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    if parsed <= 0:
        return default
    return parsed


def _non_negative_float(value: str | None, *, default: float) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    if parsed < 0:
        return default
    return parsed
