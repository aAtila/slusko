from __future__ import annotations

import os
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from slusko_worker.db.models import MeetingStatus, QueuedMeeting
from slusko_worker.db.queue import (
    CLAIM_NEXT_MEETING_SQL,
    NON_TERMINAL_STATUSES,
    PostgresMeetingQueue,
)


class RecordingTransaction:
    def __init__(self, connection: RecordingConnection) -> None:
        self.connection = connection

    def __enter__(self) -> RecordingTransaction:
        self.connection.in_transaction = True
        self.connection.events.append("begin")
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.connection.events.append("commit" if exc_type is None else "rollback")
        self.connection.in_transaction = False


class RecordingCursor:
    def __init__(self, connection: RecordingConnection) -> None:
        self.connection = connection
        self.rowcount = connection.rowcount

    def __enter__(self) -> RecordingCursor:
        self.connection.events.append("cursor_open")
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.connection.events.append("cursor_close")

    def execute(self, sql: str, params: object | None = None) -> None:
        self.connection.executed_sql = sql
        self.connection.executed_params = params
        self.connection.events.append(("execute", self.connection.in_transaction))

    def fetchone(self) -> dict[str, object] | None:
        self.connection.events.append("fetchone")
        return self.connection.row


class RecordingConnection:
    def __init__(self, row: dict[str, object] | None, *, rowcount: int = 1) -> None:
        self.row = row
        self.rowcount = rowcount
        self.events: list[object] = []
        self.in_transaction = False
        self.executed_sql = ""
        self.executed_params: object | None = None

    def __enter__(self) -> RecordingConnection:
        self.events.append("connect")
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.events.append("close")

    def transaction(self) -> RecordingTransaction:
        return RecordingTransaction(self)

    def cursor(self, **_kwargs: object) -> RecordingCursor:
        return RecordingCursor(self)


def normalize_sql(sql: str) -> str:
    return " ".join(sql.lower().split())


def test_claim_sql_matches_queue_index_predicate_and_uses_skip_locked() -> None:
    sql = normalize_sql(CLAIM_NEXT_MEETING_SQL)

    for status in NON_TERMINAL_STATUSES:
        assert f"'{status.value}'" in sql

    assert sql.startswith("with candidate as")
    assert "update meetings" in sql
    assert "status = case when candidate.claimed_status = 'pending'" in sql
    assert "for update skip locked" in sql
    assert "order by created_at asc" in sql
    assert "limit 1" in sql


def test_claim_next_executes_claim_inside_explicit_transaction() -> None:
    row = {
        "id": UUID("00000000-0000-0000-0000-000000000001"),
        "status": "pending",
        "resume_from_stage": None,
        "transcription_progress": None,
        "error_kind": None,
        "error_message": None,
        "failed_at_stage": None,
    }
    connection = RecordingConnection(row)
    queue = PostgresMeetingQueue(lambda: connection)

    meeting = queue.claim_next()

    assert meeting is not None
    assert meeting.id == row["id"]
    assert meeting.status == MeetingStatus.PENDING
    assert connection.events[:3] == ["connect", "begin", "cursor_open"]
    assert ("execute", True) in connection.events
    assert connection.events.index("commit") > connection.events.index("fetchone")


def test_claim_query_transitions_pending_claims_before_returning() -> None:
    sql = normalize_sql(CLAIM_NEXT_MEETING_SQL)

    assert "with candidate as" in sql
    assert "for update skip locked" in sql
    assert "update meetings" in sql
    assert "returning meeting.id" in sql
    assert "candidate.claimed_status as status" in sql


def test_mark_normalization_started_clears_progress_and_error_fields() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.PENDING,
        resume_from_stage=None,
        transcription_progress=50,
        error_kind=None,
        error_message="old error",
        failed_at_stage=MeetingStatus.TRANSCRIBING,
    )

    queue.mark_normalization_started(meeting)

    sql = normalize_sql(connection.executed_sql)
    assert "status = 'normalizing'" in sql
    assert "transcription_progress = null" in sql
    assert "error_kind = null" in sql
    assert "error_message = null" in sql
    assert "failed_at_stage = null" in sql
    assert "updated_at = now()" in sql
    assert "where id = %(meeting_id)s and status in ('pending', 'normalizing')" in sql
    assert connection.executed_params == {"meeting_id": meeting.id}
    assert ("execute", True) in connection.events


def test_mark_normalization_succeeded_persists_done_status_and_duration() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.NORMALIZING,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    queue.mark_normalization_succeeded(meeting=meeting, duration_seconds=42)

    sql = normalize_sql(connection.executed_sql)
    assert "status = 'done'" in sql
    assert "duration_seconds = %(duration_seconds)s" in sql
    assert "transcription_progress = null" in sql
    assert "updated_at = now()" in sql
    assert "where id = %(meeting_id)s and status = 'normalizing'" in sql
    assert connection.executed_params == {
        "meeting_id": meeting.id,
        "duration_seconds": 42,
    }
    assert ("execute", True) in connection.events


def test_status_write_raises_when_no_row_was_updated() -> None:
    connection = RecordingConnection(row=None, rowcount=0)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.NORMALIZING,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    with pytest.raises(RuntimeError, match="updated 0 rows"):
        queue.mark_normalization_succeeded(meeting=meeting, duration_seconds=42)


def test_later_stage_recovery_failure_message_names_current_vertical_slice() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=50,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    queue.mark_recovery_not_implemented(meeting)

    assert connection.executed_params == {
        "meeting_id": meeting.id,
        "error_kind": "unknown",
        "error_message": (
            "Worker recovered a meeting at 'transcribing', but recovery beyond "
            "'transcribing' is not implemented in this issue #7 normalization-only slice."
        ),
        "failed_at_stage": "transcribing",
    }


def test_real_postgres_claim_next_does_not_duplicate_pending_claim_before_processing() -> (
    None
):
    database_url = os.getenv("WORKER_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip(
            "set WORKER_TEST_DATABASE_URL to run the real production claim_next check"
        )

    schema_name = f"worker_claim_test_{uuid4().hex}"
    row_id = uuid4()

    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f'create schema "{schema_name}"')
        admin.execute(f'set search_path to "{schema_name}"')
        admin.execute(
            """
            create type meeting_status as enum (
              'pending',
              'normalizing',
              'transcribing',
              'diarizing',
              'summarizing',
              'done',
              'error'
            )
            """
        )
        admin.execute(
            """
            create table meetings (
              id uuid primary key,
              status meeting_status not null,
              resume_from_stage meeting_status,
              transcription_progress integer,
              error_kind text,
              error_message text,
              failed_at_stage meeting_status,
              created_at timestamptz not null,
              updated_at timestamptz not null default now()
            )
            """
        )
        admin.execute(
            "insert into meetings (id, status, created_at) values (%s, 'pending', now())",
            [row_id],
        )

    def connection_factory() -> psycopg.Connection[object]:
        connection = psycopg.connect(database_url)
        connection.execute(f'set search_path to "{schema_name}"')
        connection.commit()
        return connection

    try:
        queue = PostgresMeetingQueue(connection_factory)

        first_claim = queue.claim_next()
        second_claim = queue.claim_next()

        assert first_claim is not None
        assert first_claim.id == row_id
        assert first_claim.status == MeetingStatus.PENDING
        assert second_claim is None

        with connection_factory() as connection:
            row = connection.execute(
                "select status from meetings where id = %s", [row_id]
            ).fetchone()
        assert row == ("normalizing",)
    finally:
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'drop schema if exists "{schema_name}" cascade')


def test_real_postgres_skip_locked_claims_distinct_rows_when_database_available() -> (
    None
):
    database_url = os.getenv("WORKER_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("set WORKER_TEST_DATABASE_URL to run the real SKIP LOCKED check")

    schema_name = f"worker_claim_test_{uuid4().hex}"
    row_ids = [uuid4(), uuid4()]

    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f'create schema "{schema_name}"')
        admin.execute(f'set search_path to "{schema_name}"')
        admin.execute(
            """
            create type meeting_status as enum (
              'pending',
              'normalizing',
              'transcribing',
              'diarizing',
              'summarizing',
              'done',
              'error'
            )
            """
        )
        admin.execute(
            """
            create table meetings (
              id uuid primary key,
              status meeting_status not null,
              resume_from_stage meeting_status,
              transcription_progress integer,
              error_kind text,
              error_message text,
              failed_at_stage meeting_status,
              created_at timestamptz not null,
              updated_at timestamptz not null default now()
            )
            """
        )
        admin.execute(
            "insert into meetings (id, status, created_at) values (%s, 'pending', now() - interval '1 minute'), (%s, 'pending', now())",
            row_ids,
        )

    try:
        with (
            psycopg.connect(database_url) as first,
            psycopg.connect(database_url) as second,
        ):
            first.execute(f'set search_path to "{schema_name}"')
            second.execute(f'set search_path to "{schema_name}"')
            first.commit()
            second.commit()

            with first.transaction():
                with first.cursor(row_factory=dict_row) as first_cursor:
                    first_cursor.execute(CLAIM_NEXT_MEETING_SQL)
                    first_claim = first_cursor.fetchone()

                with second.transaction():
                    with second.cursor(row_factory=dict_row) as second_cursor:
                        second_cursor.execute(CLAIM_NEXT_MEETING_SQL)
                        second_claim = second_cursor.fetchone()

            assert first_claim is not None
            assert second_claim is not None
            assert first_claim["id"] != second_claim["id"]
    finally:
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'drop schema if exists "{schema_name}" cascade')
