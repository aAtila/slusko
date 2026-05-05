"""Slusko worker entrypoint."""

from __future__ import annotations

import logging
import os
import signal
from collections.abc import Iterator
from contextlib import contextmanager
from threading import Event

import psycopg

from slusko_worker.config import WorkerConfig, apply_hf_home_default, load_config
from slusko_worker.db.models import MeetingStatus
from slusko_worker.db.queue import PostgresMeetingQueue
from slusko_worker.pipeline.normalization import AudioNormalizer
from slusko_worker.pipeline.runner import PipelineProcessor
from slusko_worker.queue_loop import QueueLoop, listener_connection_factory

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
WORKER_SINGLETON_LOCK_ID = 77_000_004

logger = logging.getLogger("slusko_worker")


def configure_logging() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format=LOG_FORMAT)


def check_database(config: WorkerConfig) -> None:
    with psycopg.connect(
        config.database_url, **config.database_connect_kwargs
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute("select 1")
            cursor.fetchone()


@contextmanager
def worker_singleton_lock(config: WorkerConfig) -> Iterator[None]:
    """Hold a Postgres advisory lock so issue #7/v1 runs exactly one worker."""

    connection = psycopg.connect(config.database_url, **config.database_connect_kwargs)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "select pg_try_advisory_lock(%s)", [WORKER_SINGLETON_LOCK_ID]
            )
            row = cursor.fetchone()
        connection.commit()

        if row is None or row[0] is not True:
            raise RuntimeError(
                "another Slusko worker is already running; v1 supports exactly one worker"
            )

        yield
    finally:
        connection.close()


def handle_signal(stop_event: Event, signum: int, _frame: object) -> None:
    logger.info("received shutdown signal", extra={"signal": signum})
    stop_event.set()


def run() -> int:
    configure_logging()
    stop_requested = Event()

    def request_stop(signum: int, frame: object) -> None:
        handle_signal(stop_requested, signum, frame)

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    config = load_config()
    apply_hf_home_default(config)
    check_database(config)

    queue = PostgresMeetingQueue.from_database_url(
        config.database_url, connect_kwargs=config.database_connect_kwargs
    )
    processor = PipelineProcessor(
        queue=queue,
        normalizer=AudioNormalizer(meetings_dir=config.meetings_dir),
    )
    loop = QueueLoop(
        listener_factory=listener_connection_factory(config),
        queue=queue,
        processor=processor,
        stop_event=stop_requested,
        poll_interval_seconds=config.poll_interval_seconds,
    )

    logger.info(
        "worker starting; queue states mirrored: %s",
        ", ".join(status.value for status in MeetingStatus),
    )
    logger.info("meetings directory configured at %s", config.meetings_dir)
    logger.info("model cache directory configured at %s", config.model_cache_dir)
    logger.info(
        "queue polling fallback configured at %.0f seconds",
        config.poll_interval_seconds,
    )

    with worker_singleton_lock(config):
        loop.run()

    logger.info("worker stopped")
    return 0


def main() -> None:
    try:
        raise SystemExit(run())
    except Exception:
        logger.exception("worker failed")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
