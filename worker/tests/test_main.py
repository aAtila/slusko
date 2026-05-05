from __future__ import annotations

from typing import Any

import pytest

from slusko_worker.config import WorkerConfig
from slusko_worker.main import WORKER_SINGLETON_LOCK_ID, worker_singleton_lock


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        pass

    def execute(self, sql: str, params: list[int]) -> None:
        self.connection.events.append(("execute", sql, params))

    def fetchone(self) -> tuple[bool] | None:
        self.connection.events.append("fetchone")
        return (self.connection.lock_granted,)


class FakeConnection:
    def __init__(self, *, lock_granted: bool) -> None:
        self.lock_granted = lock_granted
        self.closed = False
        self.events: list[object] = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.events.append("commit")

    def close(self) -> None:
        self.closed = True
        self.events.append("close")


def test_worker_singleton_lock_holds_advisory_lock_until_context_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeConnection(lock_granted=True)

    def fake_connect(database_url: str, **kwargs: Any) -> FakeConnection:
        assert database_url == "postgres://example"
        assert kwargs == {"connect_timeout": 5}
        return connection

    monkeypatch.setattr("slusko_worker.main.psycopg.connect", fake_connect)

    with worker_singleton_lock(WorkerConfig(database_url="postgres://example")):
        assert connection.closed is False

    assert connection.events == [
        ("execute", "select pg_try_advisory_lock(%s)", [WORKER_SINGLETON_LOCK_ID]),
        "fetchone",
        "commit",
        "close",
    ]
    assert connection.closed is True


def test_worker_singleton_lock_rejects_second_worker_and_closes_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeConnection(lock_granted=False)
    monkeypatch.setattr(
        "slusko_worker.main.psycopg.connect", lambda *_args, **_kwargs: connection
    )

    with pytest.raises(RuntimeError, match="another Slusko worker is already running"):
        with worker_singleton_lock(WorkerConfig(database_url="postgres://example")):
            raise AssertionError("lock body should not run")

    assert connection.events == [
        ("execute", "select pg_try_advisory_lock(%s)", [WORKER_SINGLETON_LOCK_ID]),
        "fetchone",
        "commit",
        "close",
    ]
