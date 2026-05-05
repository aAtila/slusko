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
        poll_interval_seconds=float(env.get("QUEUE_POLL_INTERVAL_SECONDS", "300")),
        connect_timeout_seconds=int(env.get("DATABASE_CONNECT_TIMEOUT_SECONDS", "5")),
        tcp_keepalives=int(env.get("DATABASE_TCP_KEEPALIVES", "1")),
        tcp_keepalives_idle=int(env.get("DATABASE_TCP_KEEPALIVES_IDLE", "60")),
        tcp_keepalives_interval=int(env.get("DATABASE_TCP_KEEPALIVES_INTERVAL", "30")),
        tcp_keepalives_count=int(env.get("DATABASE_TCP_KEEPALIVES_COUNT", "5")),
    )
