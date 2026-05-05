from __future__ import annotations

from threading import Event
from uuid import UUID

from slusko_worker.db.models import MeetingStatus, QueuedMeeting
from slusko_worker.queue_loop import QueueLoop, WaitResult


class FakeListenerCursor:
    def __init__(self, listener: FakeListenerConnection) -> None:
        self.listener = listener

    def __enter__(self) -> FakeListenerCursor:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        pass

    def execute(self, sql: str) -> None:
        self.listener.events.append(("execute", sql))
        if self.listener.fail_listen:
            self.listener.fail_listen = False
            raise ConnectionError("LISTEN registration failed")
        if sql == "LISTEN meetings_pending":
            self.listener.listen_registered = True


class FakeListenerConnection:
    def __init__(
        self, wait_results: list[WaitResult], *, fail_listen: bool = False
    ) -> None:
        self.events: list[object] = []
        self.listen_registered = False
        self.wait_results = wait_results
        self.fail_listen = fail_listen

    def __enter__(self) -> FakeListenerConnection:
        self.events.append("listener_open")
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.events.append("listener_close")

    def cursor(self) -> FakeListenerCursor:
        return FakeListenerCursor(self)


class FakeQueue:
    def __init__(self, batches: list[list[QueuedMeeting]]) -> None:
        self.batches = batches
        self.events: list[object] = []
        self.current_batch: list[QueuedMeeting] | None = None

    def claim_next(self) -> QueuedMeeting | None:
        self.events.append("claim")
        if self.current_batch is None:
            if not self.batches:
                return None
            self.current_batch = self.batches.pop(0)
        if not self.current_batch:
            self.current_batch = None
            return None
        return self.current_batch.pop(0)


class RecordingProcessor:
    def __init__(self, events: list[object], *, fail_once: bool = False) -> None:
        self.events = events
        self.fail_once = fail_once

    def process(self, meeting: QueuedMeeting) -> None:
        self.events.append(("process", str(meeting.id), meeting.status.value))
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("status write failed")


def meeting(value: int, status: MeetingStatus = MeetingStatus.PENDING) -> QueuedMeeting:
    return QueuedMeeting(
        id=UUID(f"00000000-0000-0000-0000-{value:012d}"),
        status=status,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


def test_listen_is_registered_before_startup_scan() -> None:
    listener = FakeListenerConnection(wait_results=[])
    queue = FakeQueue(batches=[])
    events: list[object] = []

    def listener_factory() -> FakeListenerConnection:
        return listener

    def wait_for_work(
        _listener: FakeListenerConnection, _timeout: float, _stop_event: Event
    ) -> WaitResult:
        raise AssertionError("loop should not wait when max_wakeups=0")

    loop = QueueLoop(
        listener_factory=listener_factory,
        queue=queue,
        processor=RecordingProcessor(events),
        stop_event=Event(),
        poll_interval_seconds=300,
        wait_for_work=wait_for_work,
        before_startup_scan=lambda: events.append(
            ("startup_scan", listener.listen_registered)
        ),
    )

    loop.run(max_wakeups=0)

    assert ("execute", "LISTEN meetings_pending") in listener.events
    assert events == [("startup_scan", True)]
    assert queue.events == ["claim"]


def test_polling_fallback_drains_the_same_queue_path_as_notifications() -> None:
    listener = FakeListenerConnection(wait_results=[WaitResult.POLL_TIMEOUT])
    queue = FakeQueue(batches=[[meeting(1)], [meeting(2)]])
    events: list[object] = []

    loop = QueueLoop(
        listener_factory=lambda: listener,
        queue=queue,
        processor=RecordingProcessor(events),
        stop_event=Event(),
        poll_interval_seconds=300,
        wait_for_work=lambda _listener, _timeout, _stop_event: (
            listener.wait_results.pop(0)
        ),
    )

    loop.run(max_wakeups=1)

    assert events == [
        ("process", "00000000-0000-0000-0000-000000000001", "pending"),
        ("process", "00000000-0000-0000-0000-000000000002", "pending"),
    ]
    assert queue.events == ["claim", "claim", "claim", "claim"]


def test_notification_draining_processes_meetings_serially() -> None:
    listener = FakeListenerConnection(wait_results=[WaitResult.NOTIFICATION])
    queue = FakeQueue(batches=[[], [meeting(1), meeting(2)]])
    events: list[object] = []

    loop = QueueLoop(
        listener_factory=lambda: listener,
        queue=queue,
        processor=RecordingProcessor(events),
        stop_event=Event(),
        poll_interval_seconds=300,
        wait_for_work=lambda _listener, _timeout, _stop_event: (
            listener.wait_results.pop(0)
        ),
    )

    loop.run(max_wakeups=1)

    assert events == [
        ("process", "00000000-0000-0000-0000-000000000001", "pending"),
        ("process", "00000000-0000-0000-0000-000000000002", "pending"),
    ]
    assert queue.events == ["claim", "claim", "claim", "claim"]


def test_listener_registration_failure_reconnects_and_listens_before_scanning() -> None:
    first_listener = FakeListenerConnection(wait_results=[], fail_listen=True)
    second_listener = FakeListenerConnection(wait_results=[])
    listeners = [first_listener, second_listener]
    queue = FakeQueue(batches=[])
    events: list[object] = []

    loop = QueueLoop(
        listener_factory=lambda: listeners.pop(0),
        queue=queue,
        processor=RecordingProcessor(events),
        stop_event=Event(),
        poll_interval_seconds=300,
        listener_reconnect_backoff_seconds=0,
        before_startup_scan=lambda: events.append(
            ("startup_scan", second_listener.listen_registered)
        ),
    )

    loop.run(max_wakeups=0)

    assert first_listener.events == [
        "listener_open",
        ("execute", "LISTEN meetings_pending"),
        "listener_close",
    ]
    assert ("execute", "LISTEN meetings_pending") in second_listener.events
    assert events == [("startup_scan", True)]
    assert queue.events == ["claim"]


def test_listener_wait_failure_reopens_and_relistens_before_next_scan() -> None:
    first_listener = FakeListenerConnection(wait_results=[])
    second_listener = FakeListenerConnection(wait_results=[])
    listeners = [first_listener, second_listener]
    queue = FakeQueue(batches=[])
    events: list[object] = []

    wait_calls = 0

    def wait_for_work(
        _listener: FakeListenerConnection, _timeout: float, _stop_event: Event
    ) -> WaitResult:
        nonlocal wait_calls
        wait_calls += 1
        if wait_calls == 1:
            raise ConnectionError("listener wait failed")
        return WaitResult.SHUTDOWN

    loop = QueueLoop(
        listener_factory=lambda: listeners.pop(0),
        queue=queue,
        processor=RecordingProcessor(events),
        stop_event=Event(),
        poll_interval_seconds=300,
        wait_for_work=wait_for_work,
        listener_reconnect_backoff_seconds=0,
        before_startup_scan=lambda: events.append(("startup_scan", len(events))),
    )

    loop.run(max_wakeups=1)

    assert first_listener.events[-1] == "listener_close"
    assert ("execute", "LISTEN meetings_pending") in second_listener.events
    assert events == [("startup_scan", 0), ("startup_scan", 1)]
    assert queue.events == ["claim", "claim"]


def test_processor_exception_stops_current_drain_without_killing_future_work() -> None:
    listener = FakeListenerConnection(wait_results=[WaitResult.POLL_TIMEOUT])
    queue = FakeQueue(batches=[[meeting(1), meeting(2)]])
    events: list[object] = []

    loop = QueueLoop(
        listener_factory=lambda: listener,
        queue=queue,
        processor=RecordingProcessor(events, fail_once=True),
        stop_event=Event(),
        poll_interval_seconds=300,
        wait_for_work=lambda _listener, _timeout, _stop_event: (
            listener.wait_results.pop(0)
        ),
        drain_error_backoff_seconds=0,
    )

    loop.run(max_wakeups=1)

    assert events == [
        ("process", "00000000-0000-0000-0000-000000000001", "pending"),
        ("process", "00000000-0000-0000-0000-000000000002", "pending"),
    ]
    assert queue.events == ["claim", "claim", "claim"]


def test_shutdown_wait_result_stops_before_another_drain() -> None:
    listener = FakeListenerConnection(wait_results=[WaitResult.SHUTDOWN])
    queue = FakeQueue(batches=[])

    loop = QueueLoop(
        listener_factory=lambda: listener,
        queue=queue,
        processor=RecordingProcessor([]),
        stop_event=Event(),
        poll_interval_seconds=300,
        wait_for_work=lambda _listener, _timeout, _stop_event: (
            listener.wait_results.pop(0)
        ),
    )

    loop.run(max_wakeups=1)

    assert queue.events == ["claim"]
