"""LISTEN/NOTIFY queue loop for serialized meeting processing."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from enum import StrEnum
from threading import Event
from typing import Protocol

import psycopg

from slusko_worker.config import WorkerConfig
from slusko_worker.db.models import QueuedMeeting

logger = logging.getLogger(__name__)

LISTEN_CHANNEL = "meetings_pending"
LISTEN_SQL = f"LISTEN {LISTEN_CHANNEL}"
NOTIFICATION_WAIT_SLICE_SECONDS = 1.0


class WaitResult(StrEnum):
    NOTIFICATION = "notification"
    POLL_TIMEOUT = "poll_timeout"
    SHUTDOWN = "shutdown"


class MeetingQueue(Protocol):
    def claim_next(self) -> QueuedMeeting | None: ...


class MeetingProcessor(Protocol):
    def process(self, meeting: QueuedMeeting) -> None: ...


class ListenerConnection(Protocol):
    def __enter__(self) -> ListenerConnection: ...
    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None: ...
    def cursor(self) -> object: ...
    def notifies(self, *, timeout: float, stop_after: int) -> object: ...


ListenerFactory = Callable[[], ListenerConnection]
WaitForWork = Callable[[ListenerConnection, float, Event], WaitResult]


class QueueLoop:
    """Register LISTEN first, then drain startup and notification/poll work serially."""

    def __init__(
        self,
        *,
        listener_factory: ListenerFactory,
        queue: MeetingQueue,
        processor: MeetingProcessor,
        stop_event: Event,
        poll_interval_seconds: float,
        wait_for_work: WaitForWork | None = None,
        before_startup_scan: Callable[[], None] | None = None,
        listener_reconnect_backoff_seconds: float = 5,
        drain_error_backoff_seconds: float = 5,
    ) -> None:
        self._listener_factory = listener_factory
        self._queue = queue
        self._processor = processor
        self._stop_event = stop_event
        self._poll_interval_seconds = poll_interval_seconds
        self._wait_for_work = wait_for_work or wait_for_notification_or_poll_timeout
        self._before_startup_scan = before_startup_scan
        self._listener_reconnect_backoff_seconds = listener_reconnect_backoff_seconds
        self._drain_error_backoff_seconds = drain_error_backoff_seconds

    def run(self, *, max_wakeups: int | None = None) -> None:
        """Run until shutdown, optionally bounded for tests."""

        wakeups = 0
        while not self._stop_event.is_set():
            try:
                with self._listener_factory() as listener:
                    register_listener(listener)
                    if self._before_startup_scan is not None:
                        self._before_startup_scan()
                    self.drain_queue()

                    while not self._stop_event.is_set():
                        if max_wakeups is not None and wakeups >= max_wakeups:
                            return

                        wait_result = self._wait_for_work(
                            listener, self._poll_interval_seconds, self._stop_event
                        )
                        wakeups += 1

                        if wait_result == WaitResult.SHUTDOWN:
                            return

                        logger.debug("draining queue after %s", wait_result.value)
                        self.drain_queue()
            except Exception:
                if self._stop_event.is_set():
                    return
                logger.exception("listener failed; reconnecting after backoff")
                self._backoff(self._listener_reconnect_backoff_seconds)

    def drain_queue(self) -> None:
        """Claim and process one meeting at a time until no work remains."""

        while not self._stop_event.is_set():
            try:
                meeting = self._queue.claim_next()
            except Exception:
                logger.exception(
                    "queue claim failed; stopping current drain after backoff"
                )
                self._backoff(self._drain_error_backoff_seconds)
                return

            if meeting is None:
                return

            logger.info(
                "claimed meeting %s at status %s", meeting.id, meeting.status.value
            )
            try:
                self._processor.process(meeting)
            except Exception:
                logger.exception(
                    "meeting %s processing failed outside pipeline policy; stopping current drain after backoff",
                    meeting.id,
                )
                self._backoff(self._drain_error_backoff_seconds)
                return

    def _backoff(self, seconds: float) -> None:
        if seconds <= 0:
            return
        self._stop_event.wait(seconds)


def register_listener(listener: ListenerConnection) -> None:
    with listener.cursor() as cursor:
        cursor.execute(LISTEN_SQL)


def listener_connection_factory(config: WorkerConfig) -> ListenerFactory:
    def connect() -> ListenerConnection:
        return psycopg.connect(config.database_url, **config.listener_connect_kwargs)

    return connect


def wait_for_notification_or_poll_timeout(
    listener: ListenerConnection, poll_interval_seconds: float, stop_event: Event
) -> WaitResult:
    """Wait for NOTIFY while periodically checking shutdown and poll fallback timeouts."""

    deadline = time.monotonic() + poll_interval_seconds
    while not stop_event.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return WaitResult.POLL_TIMEOUT

        timeout = min(remaining, NOTIFICATION_WAIT_SLICE_SECONDS)
        notification = next(listener.notifies(timeout=timeout, stop_after=1), None)
        if notification is not None:
            logger.debug("received %s notification", LISTEN_CHANNEL)
            return WaitResult.NOTIFICATION

    return WaitResult.SHUTDOWN
