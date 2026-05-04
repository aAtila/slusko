"""Minimal worker entrypoint.

This scaffold only verifies database connectivity and stays alive. The real
LISTEN/NOTIFY queue loop and pipeline stages will be added in later work.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import time
from threading import Event

import psycopg

from slusko_worker.db.models import MeetingStatus

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
SLEEP_SECONDS = 30

logger = logging.getLogger("slusko_worker")
stop_requested = Event()


def configure_logging() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format=LOG_FORMAT)


def get_database_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to start the worker")
    return database_url


def check_database(database_url: str) -> None:
    with psycopg.connect(database_url, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            cursor.execute("select 1")
            cursor.fetchone()


def handle_signal(signum: int, _frame: object) -> None:
    logger.info("received shutdown signal", extra={"signal": signum})
    stop_requested.set()


def run() -> int:
    configure_logging()
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    database_url = get_database_url()
    meetings_dir = os.getenv("MEETINGS_DIR", "/data/meetings")

    check_database(database_url)
    logger.info(
        "worker started as no-op DB-check process; queue states mirrored: %s",
        ", ".join(status.value for status in MeetingStatus),
    )
    logger.info("meetings directory configured at %s", meetings_dir)

    while not stop_requested.wait(SLEEP_SECONDS):
        logger.info("worker idle; pipeline loop not implemented yet")

    logger.info("worker stopped")
    return 0


def main() -> None:
    try:
        raise SystemExit(run())
    except Exception:
        logger.exception("worker failed to start")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
