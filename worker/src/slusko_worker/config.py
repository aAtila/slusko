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
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_timeout_seconds: float = 120.0
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


def validate_startup_config(config: WorkerConfig) -> None:
    missing: list[str] = []

    def require(value: str | None, env_name: str) -> None:
        if value is None or not value.strip():
            missing.append(env_name)

    require(config.database_url, "DATABASE_URL")
    require(config.huggingface_token, "HUGGINGFACE_TOKEN or HF_TOKEN")
    require(config.pyannote_model, "PYANNOTE_MODEL")
    require(config.whisper_model, "WHISPER_MODEL")
    require(config.openrouter_api_key, "OPENROUTER_API_KEY")
    require(config.openrouter_model, "OPENROUTER_MODEL")
    require(config.model_cache_dir, "MODEL_CACHE_DIR")
    require(config.hf_home, "HF_HOME")

    if missing:
        raise RuntimeError(
            "Worker startup config is invalid. Missing/blank required settings: "
            + ", ".join(missing)
            + ". Set required environment variables and restart the worker."
        )


def load_config(environ: dict[str, str] | None = None) -> WorkerConfig:
    env = environ if environ is not None else os.environ
    database_url = env.get("DATABASE_URL", "")

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
        huggingface_token=_first_non_blank(
            env.get("HUGGINGFACE_TOKEN"), env.get("HF_TOKEN")
        ),
        openrouter_api_key=env.get("OPENROUTER_API_KEY") or None,
        openrouter_model=env.get("OPENROUTER_MODEL") or None,
        openrouter_base_url=env.get(
            "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
        ),
        openrouter_timeout_seconds=_positive_float(
            env.get("OPENROUTER_TIMEOUT_SECONDS"), default=120.0
        ),
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


def _first_non_blank(*values: str | None) -> str | None:
    for value in values:
        if value is not None and value.strip():
            return value
    return None


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


def _positive_float(value: str | None, *, default: float) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
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
