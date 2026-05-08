from __future__ import annotations

from typing import Any

import pytest

from slusko_worker.config import WorkerConfig
from slusko_worker.main import WORKER_SINGLETON_LOCK_ID, run, worker_singleton_lock


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


def test_run_surfaces_aggregate_startup_validation_including_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("slusko_worker.main.configure_logging", lambda: None)
    monkeypatch.setattr("slusko_worker.main.signal.signal", lambda *_args: None)

    def fake_load_config() -> WorkerConfig:
        return WorkerConfig(
            database_url="",
            huggingface_token="",
            whisper_model="",
            pyannote_model="",
            openrouter_api_key="",
            openrouter_model="",
            model_cache_dir="",
            hf_home="",
        )

    def fail_if_called(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("should not be called before startup validation passes")

    monkeypatch.setattr("slusko_worker.main.load_config", fake_load_config)
    monkeypatch.setattr("slusko_worker.main.check_database", fail_if_called)
    monkeypatch.setattr(
        "slusko_worker.main.PostgresMeetingQueue.from_database_url", fail_if_called
    )

    with pytest.raises(RuntimeError) as exc:
        run()

    message = str(exc.value)
    assert "Worker startup config is invalid" in message
    assert "DATABASE_URL" in message
    assert "OPENROUTER_API_KEY" in message


def test_run_validates_startup_config_before_database_or_queue_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    monkeypatch.setattr("slusko_worker.main.configure_logging", lambda: None)
    monkeypatch.setattr("slusko_worker.main.signal.signal", lambda *_args: None)

    config = WorkerConfig(database_url="postgres://example")

    def fake_load_config() -> WorkerConfig:
        calls.append("load_config")
        return config

    def fake_apply_hf_home_default(_config: WorkerConfig) -> None:
        calls.append("apply_hf_home_default")

    def fake_validate_startup_config(_config: WorkerConfig) -> None:
        calls.append("validate_startup_config")
        raise RuntimeError("missing required startup config")

    def fail_if_called(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("should not be called before startup validation passes")

    monkeypatch.setattr("slusko_worker.main.load_config", fake_load_config)
    monkeypatch.setattr("slusko_worker.main.apply_hf_home_default", fake_apply_hf_home_default)
    monkeypatch.setattr(
        "slusko_worker.main.validate_startup_config", fake_validate_startup_config
    )
    monkeypatch.setattr("slusko_worker.main.check_database", fail_if_called)
    monkeypatch.setattr(
        "slusko_worker.main.PostgresMeetingQueue.from_database_url", fail_if_called
    )

    with pytest.raises(RuntimeError, match="missing required startup config"):
        run()

    assert calls == ["load_config", "apply_hf_home_default", "validate_startup_config"]
