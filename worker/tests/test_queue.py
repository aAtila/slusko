from __future__ import annotations

import os
from decimal import Decimal
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from slusko_worker.db.models import (
    ErrorKind,
    MeetingStatus,
    QueuedMeeting,
    SummaryActionItemDraft,
    SummaryActionItemOwnerDraft,
    SummaryDecisionDraft,
    SummaryDraft,
    SummaryOpenQuestionDraft,
    TranscriptSegmentDraft,
)
from slusko_worker.db.queue import (
    CLAIM_NEXT_MEETING_SQL,
    MARK_DIARIZATION_STARTED_SQL,
    MARK_DIARIZATION_SUCCEEDED_SQL,
    MARK_FAILURE_SQL,
    MARK_NORMALIZATION_STARTED_SQL,
    MARK_SUMMARIZATION_STARTED_SQL,
    MARK_SUMMARIZATION_SUCCEEDED_SQL,
    MARK_TRANSCRIPTION_STARTED_SQL,
    MARK_TRANSCRIPTION_SUCCEEDED_SQL,
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
        self.rowcount = self.connection.next_rowcount()
        self.connection.executed_sql = sql
        self.connection.executed_params = params
        self.connection.executed_statements.append((sql, params))
        self.connection.events.append(("execute", self.connection.in_transaction))

    def fetchone(self) -> dict[str, object] | None:
        self.connection.events.append("fetchone")
        return self.connection.row

    def fetchall(self) -> list[dict[str, object]]:
        self.connection.events.append("fetchall")
        return self.connection.rows


class RecordingConnection:
    def __init__(
        self,
        row: dict[str, object] | None,
        *,
        rows: list[dict[str, object]] | None = None,
        rowcount: int = 1,
        rowcounts: list[int] | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []
        self.rowcount = rowcount
        self.rowcounts = rowcounts or []
        self.events: list[object] = []
        self.in_transaction = False
        self.executed_sql = ""
        self.executed_params: object | None = None
        self.executed_statements: list[tuple[str, object | None]] = []

    def next_rowcount(self) -> int:
        if self.rowcounts:
            return self.rowcounts.pop(0)
        return self.rowcount

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
    assert "when candidate.claimed_status = 'pending' then 'normalizing'::meeting_status" in sql
    assert "else candidate.claimed_status end as status" in sql


def test_claim_query_promotes_pending_retry_to_resume_stage() -> None:
    sql = normalize_sql(CLAIM_NEXT_MEETING_SQL)

    assert "candidate.claimed_status = 'pending' and candidate.resume_from_stage in" in sql
    for status in (
        MeetingStatus.NORMALIZING,
        MeetingStatus.TRANSCRIBING,
        MeetingStatus.DIARIZING,
        MeetingStatus.SUMMARIZING,
    ):
        assert f"'{status.value}'" in sql
    assert "then candidate.resume_from_stage" in sql
    assert "resume_from_stage = null" in sql
    assert "as status" in sql


def test_claim_next_returns_effective_retry_stage_to_processor() -> None:
    row = {
        "id": UUID("00000000-0000-0000-0000-000000000001"),
        "status": "diarizing",
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
    assert meeting.status == MeetingStatus.DIARIZING
    assert meeting.resume_from_stage is None


def test_stage_status_writes_clear_stale_resume_stage() -> None:
    for sql in (
        MARK_NORMALIZATION_STARTED_SQL,
        MARK_TRANSCRIPTION_STARTED_SQL,
        MARK_TRANSCRIPTION_SUCCEEDED_SQL,
        MARK_DIARIZATION_STARTED_SQL,
        MARK_DIARIZATION_SUCCEEDED_SQL,
        MARK_SUMMARIZATION_STARTED_SQL,
        MARK_SUMMARIZATION_SUCCEEDED_SQL,
        MARK_FAILURE_SQL,
    ):
        assert "resume_from_stage = null" in normalize_sql(sql)


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


def test_mark_transcription_started_enters_stage_with_duration_and_clears_stale_segments() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.NORMALIZING,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message="old error",
        failed_at_stage=MeetingStatus.TRANSCRIBING,
    )

    queue.mark_transcription_started(meeting=meeting, duration_seconds=42)

    statements = [(normalize_sql(sql), params) for sql, params in connection.executed_statements]
    assert len(statements) == 2
    assert statements[0] == (
        "delete from transcript_segments where meeting_id = %(meeting_id)s",
        {"meeting_id": meeting.id},
    )
    update_sql, update_params = statements[1]
    assert "status = 'transcribing'" in update_sql
    assert "duration_seconds = coalesce(%(duration_seconds)s, duration_seconds)" in update_sql
    assert "transcription_progress = 0" in update_sql
    assert "error_kind = null" in update_sql
    assert "error_message = null" in update_sql
    assert "failed_at_stage = null" in update_sql
    assert "where id = %(meeting_id)s and status in ('normalizing', 'transcribing')" in update_sql
    assert update_params == {"meeting_id": meeting.id, "duration_seconds": 42}
    assert connection.events.count(("execute", True)) == 2


def test_mark_transcription_progress_persists_monotonic_non_terminal_progress() -> None:
    connection = RecordingConnection(row=None, rowcount=0)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=10,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    queue.mark_transcription_progress(meeting=meeting, progress=25)

    sql = normalize_sql(connection.executed_sql)
    assert "transcription_progress = %(progress)s" in sql
    assert "status = 'transcribing'" in sql
    assert "transcription_progress < %(progress)s" in sql
    assert connection.executed_params == {"meeting_id": meeting.id, "progress": 25}
    assert ("execute", True) in connection.events


def test_mark_transcription_progress_rejects_terminal_or_invalid_progress() -> None:
    queue = PostgresMeetingQueue(lambda: RecordingConnection(row=None))
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=10,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    for progress in (-1, 100, 101):
        with pytest.raises(ValueError, match="progress must be between 0 and 99"):
            queue.mark_transcription_progress(meeting=meeting, progress=progress)


def test_mark_transcription_succeeded_replaces_segments_and_marks_diarizing() -> None:
    connection = RecordingConnection(row=None, rowcounts=[1, 1, 1, 1])
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=95,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )
    segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.5,
            speaker_label="SPEAKER_00",
            text="Hello world",
        ),
        TranscriptSegmentDraft(
            start_seconds=1.5,
            end_seconds=3.25,
            speaker_label="SPEAKER_00",
            text="Second segment",
        ),
    ]

    queue.mark_transcription_succeeded(meeting=meeting, segments=segments)

    statements = [(normalize_sql(sql), params) for sql, params in connection.executed_statements]
    assert statements[0] == (
        "delete from transcript_segments where meeting_id = %(meeting_id)s",
        {"meeting_id": meeting.id},
    )
    first_insert_sql, first_insert_params = statements[1]
    assert first_insert_sql.startswith("insert into transcript_segments")
    assert first_insert_params == {
        "meeting_id": meeting.id,
        "start_seconds": "0.000",
        "end_seconds": "1.500",
        "speaker_label": "SPEAKER_00",
        "text": "Hello world",
    }
    update_sql, update_params = statements[-1]
    assert "status = 'diarizing'" in update_sql
    assert "transcription_progress = 100" in update_sql
    assert "where id = %(meeting_id)s and status = 'transcribing'" in update_sql
    assert update_params == {"meeting_id": meeting.id}


def test_load_transcript_segments_returns_ordered_segment_drafts() -> None:
    meeting_id = UUID("00000000-0000-0000-0000-000000000001")
    connection = RecordingConnection(
        row=None,
        rows=[
            {
                "start_seconds": Decimal("0.500"),
                "end_seconds": Decimal("1.250"),
                "speaker_label": "SPEAKER_00",
                "text": "First by time",
            },
            {
                "start_seconds": Decimal("1.250"),
                "end_seconds": Decimal("2.000"),
                "speaker_label": "SPEAKER_01",
                "text": "Second by time",
            },
        ],
    )
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=meeting_id,
        status=MeetingStatus.DIARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    segments = queue.load_transcript_segments(meeting)

    sql = normalize_sql(connection.executed_sql)
    assert "from transcript_segments" in sql
    assert "where meeting_id = %(meeting_id)s" in sql
    assert "order by start_seconds asc, end_seconds asc, id asc" in sql
    assert connection.executed_params == {"meeting_id": meeting_id}
    assert segments == [
        TranscriptSegmentDraft(
            start_seconds=0.5,
            end_seconds=1.25,
            speaker_label="SPEAKER_00",
            text="First by time",
        ),
        TranscriptSegmentDraft(
            start_seconds=1.25,
            end_seconds=2.0,
            speaker_label="SPEAKER_01",
            text="Second by time",
        ),
    ]


def test_mark_diarization_started_clears_errors_and_preserves_transcript_rows() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.DIARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=ErrorKind.UNKNOWN,
        error_message="stale diarization failure",
        failed_at_stage=MeetingStatus.DIARIZING,
    )

    queue.mark_diarization_started(meeting)

    statements = [(normalize_sql(sql), params) for sql, params in connection.executed_statements]
    assert len(statements) == 1
    sql, params = statements[0]
    assert "status = 'diarizing'" in sql
    assert "error_kind = null" in sql
    assert "error_message = null" in sql
    assert "failed_at_stage = null" in sql
    assert "where id = %(meeting_id)s and status = 'diarizing'" in sql
    assert "delete from transcript_segments" not in sql
    assert params == {"meeting_id": meeting.id}


def test_mark_diarization_succeeded_replaces_segments_and_marks_summarizing() -> None:
    connection = RecordingConnection(row=None, rowcounts=[1, 1, 1, 1])
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.DIARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )
    segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.5,
            speaker_label="SPEAKER_00",
            text="Hello world",
        ),
        TranscriptSegmentDraft(
            start_seconds=1.5,
            end_seconds=3.25,
            speaker_label="SPEAKER_01",
            text="Second speaker",
        ),
    ]

    queue.mark_diarization_succeeded(meeting=meeting, segments=segments)

    statements = [(normalize_sql(sql), params) for sql, params in connection.executed_statements]
    assert statements[0] == (
        "delete from transcript_segments where meeting_id = %(meeting_id)s",
        {"meeting_id": meeting.id},
    )
    first_insert_sql, first_insert_params = statements[1]
    assert first_insert_sql.startswith("insert into transcript_segments")
    assert first_insert_params == {
        "meeting_id": meeting.id,
        "start_seconds": "0.000",
        "end_seconds": "1.500",
        "speaker_label": "SPEAKER_00",
        "text": "Hello world",
    }
    update_sql, update_params = statements[-1]
    assert "status = 'summarizing'" in update_sql
    assert "error_kind = null" in update_sql
    assert "error_message = null" in update_sql
    assert "failed_at_stage = null" in update_sql
    assert "where id = %(meeting_id)s and status = 'diarizing'" in update_sql
    assert update_params == {"meeting_id": meeting.id}


def test_mark_summarization_started_clears_errors_and_preserves_transcript_rows() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.SUMMARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=ErrorKind.SUMMARIZATION_FAILED,
        error_message="stale summary failure",
        failed_at_stage=MeetingStatus.SUMMARIZING,
    )

    queue.mark_summarization_started(meeting)

    statements = [(normalize_sql(sql), params) for sql, params in connection.executed_statements]
    assert len(statements) == 1
    sql, params = statements[0]
    assert "status = 'summarizing'" in sql
    assert "error_kind = null" in sql
    assert "error_message = null" in sql
    assert "failed_at_stage = null" in sql
    assert "where id = %(meeting_id)s and status = 'summarizing'" in sql
    assert "delete from transcript_segments" not in sql
    assert params == {"meeting_id": meeting.id}


def test_mark_summarization_succeeded_upserts_summary_and_marks_done() -> None:
    connection = RecordingConnection(row=None, rowcounts=[1, 1])
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.SUMMARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )
    summary = SummaryDraft(
        overview="Meeting overview",
        decisions=(SummaryDecisionDraft(text="Ship it"),),
        action_items=(
            SummaryActionItemDraft(
                task="Send notes",
                owner=SummaryActionItemOwnerDraft(kind="speaker", value="SPEAKER_00"),
            ),
            SummaryActionItemDraft(
                task="Publish recap",
                owner=SummaryActionItemOwnerDraft(kind="unknown"),
            ),
        ),
        open_questions=(SummaryOpenQuestionDraft(text="Who owns rollout?"),),
    )

    queue.mark_summarization_succeeded(meeting=meeting, summary=summary)

    statements = [(normalize_sql(sql), params) for sql, params in connection.executed_statements]
    assert len(statements) == 2
    upsert_sql, upsert_params = statements[0]
    assert upsert_sql.startswith("insert into summaries")
    assert "on conflict (meeting_id) do update" in upsert_sql
    assert isinstance(upsert_params, dict)
    assert upsert_params["meeting_id"] == meeting.id
    assert upsert_params["overview"] == "Meeting overview"
    assert upsert_params["decisions"].obj == [{"text": "Ship it"}]
    assert upsert_params["action_items"].obj == [
        {"task": "Send notes", "owner": {"kind": "speaker", "value": "SPEAKER_00"}},
        {"task": "Publish recap", "owner": {"kind": "unknown"}},
    ]
    assert upsert_params["open_questions"].obj == [{"text": "Who owns rollout?"}]
    update_sql, update_params = statements[1]
    assert "status = 'done'" in update_sql
    assert "transcription_progress = 100" in update_sql
    assert "error_kind = null" in update_sql
    assert "error_message = null" in update_sql
    assert "failed_at_stage = null" in update_sql
    assert "where id = %(meeting_id)s and status = 'summarizing'" in update_sql
    assert update_params == {"meeting_id": meeting.id}


def test_mark_summarization_succeeded_raises_when_final_status_update_misses() -> None:
    connection = RecordingConnection(row=None, rowcounts=[1, 0])
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.SUMMARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    with pytest.raises(RuntimeError, match="updated 0 rows"):
        queue.mark_summarization_succeeded(
            meeting=meeting,
            summary=SummaryDraft(
                overview="Overview",
                decisions=(),
                action_items=(),
                open_questions=(),
            ),
        )


def test_mark_transcription_succeeded_raises_when_final_status_update_misses() -> None:
    connection = RecordingConnection(row=None, rowcounts=[1, 1, 0])
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=95,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    with pytest.raises(RuntimeError, match="updated 0 rows"):
        queue.mark_transcription_succeeded(
            meeting=meeting,
            segments=[
                TranscriptSegmentDraft(
                    start_seconds=0.0,
                    end_seconds=1.0,
                    speaker_label="SPEAKER_00",
                    text="Hello world",
                )
            ],
        )


def test_mark_diarization_succeeded_raises_when_final_status_update_misses() -> None:
    connection = RecordingConnection(row=None, rowcounts=[1, 1, 0])
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.DIARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    with pytest.raises(RuntimeError, match="updated 0 rows"):
        queue.mark_diarization_succeeded(
            meeting=meeting,
            segments=[
                TranscriptSegmentDraft(
                    start_seconds=0.0,
                    end_seconds=1.0,
                    speaker_label="SPEAKER_00",
                    text="Hello world",
                )
            ],
        )


def test_mark_diarization_succeeded_rejects_empty_segments() -> None:
    queue = PostgresMeetingQueue(lambda: RecordingConnection(row=None))
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.DIARIZING,
        resume_from_stage=None,
        transcription_progress=100,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    with pytest.raises(ValueError, match="at least one transcript segment"):
        queue.mark_diarization_succeeded(meeting=meeting, segments=[])


def test_mark_transcription_succeeded_rejects_empty_segments() -> None:
    queue = PostgresMeetingQueue(lambda: RecordingConnection(row=None))
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.TRANSCRIBING,
        resume_from_stage=None,
        transcription_progress=95,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )

    with pytest.raises(ValueError, match="at least one transcript segment"):
        queue.mark_transcription_succeeded(meeting=meeting, segments=[])


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
        queue.mark_transcription_started(meeting=meeting, duration_seconds=42)


def test_later_stage_recovery_failure_message_names_current_vertical_slice() -> None:
    connection = RecordingConnection(row=None)
    queue = PostgresMeetingQueue(lambda: connection)
    meeting = QueuedMeeting(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        status=MeetingStatus.DIARIZING,
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
            "Worker recovered a meeting at 'diarizing', but recovery beyond "
            "'diarizing' is not implemented in this issue #8 transcription slice."
        ),
        "failed_at_stage": "diarizing",
    }


def test_real_postgres_diarization_queue_transitions_are_idempotent() -> None:
    database_url = os.getenv("WORKER_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip(
            "set WORKER_TEST_DATABASE_URL to run the real transcript persistence check"
        )

    schema_name = f"worker_transcript_test_{uuid4().hex}"
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
              duration_seconds integer,
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
            """
            create table transcript_segments (
              id uuid primary key default (md5(random()::text || clock_timestamp()::text)::uuid),
              meeting_id uuid not null references meetings(id) on delete cascade,
              start_seconds numeric(10, 3) not null,
              end_seconds numeric(10, 3) not null,
              speaker_label text not null,
              text text not null
            )
            """
        )
        admin.execute(
            """
            create table summaries (
              meeting_id uuid primary key references meetings(id) on delete cascade,
              overview text not null default '',
              decisions jsonb not null default '[]'::jsonb,
              action_items jsonb not null default '[]'::jsonb,
              open_questions jsonb not null default '[]'::jsonb,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        admin.execute(
            "insert into meetings (id, status, created_at) values (%s, 'transcribing', now())",
            [row_id],
        )

    def connection_factory() -> psycopg.Connection[object]:
        connection = psycopg.connect(database_url)
        connection.execute(f'set search_path to "{schema_name}"')
        connection.commit()
        return connection

    try:
        queue = PostgresMeetingQueue(connection_factory)
        transcribing_meeting = QueuedMeeting(
            id=row_id,
            status=MeetingStatus.TRANSCRIBING,
            resume_from_stage=None,
            transcription_progress=None,
            error_kind=None,
            error_message=None,
            failed_at_stage=None,
        )

        queue.mark_transcription_succeeded(
            meeting=transcribing_meeting,
            segments=[
                TranscriptSegmentDraft(
                    start_seconds=0.0,
                    end_seconds=1.0,
                    speaker_label="SPEAKER_00",
                    text="stale segment",
                )
            ],
        )
        with connection_factory() as connection:
            connection.execute(
                "update meetings set status = 'transcribing' where id = %s", [row_id]
            )
            connection.commit()

        queue.mark_transcription_succeeded(
            meeting=transcribing_meeting,
            segments=[
                TranscriptSegmentDraft(
                    start_seconds=0.0,
                    end_seconds=1.0,
                    speaker_label="SPEAKER_00",
                    text="replacement one",
                ),
                TranscriptSegmentDraft(
                    start_seconds=1.0,
                    end_seconds=2.0,
                    speaker_label="SPEAKER_00",
                    text="replacement two",
                ),
            ],
        )

        diarizing_meeting = QueuedMeeting(
            id=row_id,
            status=MeetingStatus.DIARIZING,
            resume_from_stage=None,
            transcription_progress=100,
            error_kind=None,
            error_message=None,
            failed_at_stage=None,
        )
        loaded_segments = queue.load_transcript_segments(diarizing_meeting)

        assert loaded_segments == [
            TranscriptSegmentDraft(
                start_seconds=0.0,
                end_seconds=1.0,
                speaker_label="SPEAKER_00",
                text="replacement one",
            ),
            TranscriptSegmentDraft(
                start_seconds=1.0,
                end_seconds=2.0,
                speaker_label="SPEAKER_00",
                text="replacement two",
            ),
        ]

        with connection_factory() as connection:
            connection.execute(
                """
                update meetings
                set error_kind = 'unknown',
                    error_message = 'stale error',
                    failed_at_stage = 'diarizing'
                where id = %s
                """,
                [row_id],
            )
            connection.commit()

        queue.mark_diarization_started(diarizing_meeting)

        with connection_factory() as connection:
            started_segment_count = connection.execute(
                "select count(*) from transcript_segments where meeting_id = %s",
                [row_id],
            ).fetchone()
            started_meeting_row = connection.execute(
                """
                select status, transcription_progress, error_kind, error_message, failed_at_stage
                from meetings
                where id = %s
                """,
                [row_id],
            ).fetchone()

        assert started_segment_count == (2,)
        assert started_meeting_row == ("diarizing", 100, None, None, None)

        queue.mark_diarization_succeeded(
            meeting=diarizing_meeting,
            segments=[
                TranscriptSegmentDraft(
                    start_seconds=0.0,
                    end_seconds=1.0,
                    speaker_label="SPEAKER_01",
                    text="replacement one",
                ),
                TranscriptSegmentDraft(
                    start_seconds=1.0,
                    end_seconds=2.0,
                    speaker_label="SPEAKER_00",
                    text="replacement two",
                ),
            ],
        )

        with connection_factory() as connection:
            segment_rows = connection.execute(
                """
                select speaker_label, text
                from transcript_segments
                where meeting_id = %s
                order by start_seconds
                """,
                [row_id],
            ).fetchall()
            meeting_row = connection.execute(
                "select status, transcription_progress from meetings where id = %s",
                [row_id],
            ).fetchone()

        assert segment_rows == [
            ("SPEAKER_01", "replacement one"),
            ("SPEAKER_00", "replacement two"),
        ]
        assert meeting_row == ("summarizing", 100)

        summarizing_meeting = QueuedMeeting(
            id=row_id,
            status=MeetingStatus.SUMMARIZING,
            resume_from_stage=None,
            transcription_progress=100,
            error_kind=None,
            error_message=None,
            failed_at_stage=None,
        )
        queue.mark_summarization_succeeded(
            meeting=summarizing_meeting,
            summary=SummaryDraft(
                overview="stale overview",
                decisions=(SummaryDecisionDraft(text="stale decision"),),
                action_items=(),
                open_questions=(),
            ),
        )
        with connection_factory() as connection:
            connection.execute(
                "update meetings set status = 'summarizing' where id = %s", [row_id]
            )
            connection.commit()

        queue.mark_summarization_succeeded(
            meeting=summarizing_meeting,
            summary=SummaryDraft(
                overview="replacement overview",
                decisions=(SummaryDecisionDraft(text="replacement decision"),),
                action_items=(
                    SummaryActionItemDraft(
                        task="Follow up",
                        owner=SummaryActionItemOwnerDraft(
                            kind="speaker", value="SPEAKER_01"
                        ),
                    ),
                ),
                open_questions=(SummaryOpenQuestionDraft(text="Replacement question?"),),
            ),
        )

        with connection_factory() as connection:
            summary_rows = connection.execute(
                """
                select overview, decisions, action_items, open_questions
                from summaries
                where meeting_id = %s
                """,
                [row_id],
            ).fetchall()
            done_meeting_row = connection.execute(
                "select status, transcription_progress from meetings where id = %s",
                [row_id],
            ).fetchone()

        assert summary_rows == [
            (
                "replacement overview",
                [{"text": "replacement decision"}],
                [
                    {
                        "task": "Follow up",
                        "owner": {"kind": "speaker", "value": "SPEAKER_01"},
                    }
                ],
                [{"text": "Replacement question?"}],
            )
        ]
        assert done_meeting_row == ("done", 100)
    finally:
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'drop schema if exists "{schema_name}" cascade')


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


def test_real_postgres_claim_next_promotes_pending_retry_to_resume_stage() -> None:
    database_url = os.getenv("WORKER_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip(
            "set WORKER_TEST_DATABASE_URL to run the real retry claim_next check"
        )

    schema_name = f"worker_retry_claim_test_{uuid4().hex}"
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
            """
            insert into meetings (
              id,
              status,
              resume_from_stage,
              transcription_progress,
              error_kind,
              error_message,
              failed_at_stage,
              created_at
            ) values (
              %s,
              'pending',
              'diarizing',
              75,
              'diarization_failed',
              'stale failure',
              'diarizing',
              now()
            )
            """,
            [row_id],
        )

    def connection_factory() -> psycopg.Connection[object]:
        connection = psycopg.connect(database_url)
        connection.execute(f'set search_path to "{schema_name}"')
        connection.commit()
        return connection

    try:
        queue = PostgresMeetingQueue(connection_factory)

        claim = queue.claim_next()
        duplicate_claim = queue.claim_next()

        assert claim is not None
        assert claim.id == row_id
        assert claim.status == MeetingStatus.DIARIZING
        assert claim.resume_from_stage is None
        assert claim.transcription_progress is None
        assert claim.error_kind is None
        assert claim.error_message is None
        assert claim.failed_at_stage is None
        assert duplicate_claim is None

        with connection_factory() as connection:
            row = connection.execute(
                """
                select
                  status,
                  resume_from_stage,
                  transcription_progress,
                  error_kind,
                  error_message,
                  failed_at_stage
                from meetings
                where id = %s
                """,
                [row_id],
            ).fetchone()
        assert row == ("diarizing", None, None, None, None, None)
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
