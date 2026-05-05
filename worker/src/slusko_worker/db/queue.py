"""Postgres-backed meeting queue helpers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import psycopg
from psycopg.rows import dict_row

from slusko_worker.db.models import ErrorKind, MeetingStatus, QueuedMeeting

NON_TERMINAL_STATUSES: tuple[MeetingStatus, ...] = (
    MeetingStatus.PENDING,
    MeetingStatus.NORMALIZING,
    MeetingStatus.TRANSCRIBING,
    MeetingStatus.DIARIZING,
    MeetingStatus.SUMMARIZING,
)

# V1 is enforced as a singleton worker process in main.py. This interval only
# makes immediate post-claim duplicate claims invisible and allows stale
# non-terminal rows to be retried after a restart; it is not a multi-worker
# lease/heartbeat model.
RECOVERY_RECLAIM_INTERVAL_SQL = "5 minutes"

CLAIM_NEXT_MEETING_SQL = f"""
with candidate as (
  select
    id,
    status as claimed_status,
    resume_from_stage,
    transcription_progress,
    error_kind,
    error_message,
    failed_at_stage
  from meetings
  where status = 'pending'
    or (
      status in (
        'normalizing',
        'transcribing',
        'diarizing',
        'summarizing'
      )
      and updated_at < now() - interval '{RECOVERY_RECLAIM_INTERVAL_SQL}'
    )
  order by created_at asc
  for update skip locked
  limit 1
), claimed as (
  update meetings as meeting
  set
    status = case when candidate.claimed_status = 'pending' then 'normalizing' else meeting.status end,
    transcription_progress = case when candidate.claimed_status = 'pending' then null else meeting.transcription_progress end,
    error_kind = case when candidate.claimed_status = 'pending' then null else meeting.error_kind end,
    error_message = case when candidate.claimed_status = 'pending' then null else meeting.error_message end,
    failed_at_stage = case when candidate.claimed_status = 'pending' then null else meeting.failed_at_stage end,
    updated_at = now()
  from candidate
  where meeting.id = candidate.id
  returning
    meeting.id,
    candidate.claimed_status as status,
    candidate.resume_from_stage,
    candidate.transcription_progress,
    candidate.error_kind,
    candidate.error_message,
    candidate.failed_at_stage
)
select * from claimed
"""

MARK_NORMALIZATION_STARTED_SQL = """
update meetings
set
  status = 'normalizing',
  transcription_progress = null,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status in ('pending', 'normalizing')
"""

MARK_NORMALIZATION_SUCCEEDED_SQL = """
update meetings
set
  status = 'done',
  duration_seconds = %(duration_seconds)s,
  transcription_progress = null,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'normalizing'
"""

MARK_FAILURE_SQL = """
update meetings
set
  status = 'error',
  error_kind = %(error_kind)s,
  error_message = %(error_message)s,
  failed_at_stage = %(failed_at_stage)s,
  transcription_progress = null,
  updated_at = now()
where id = %(meeting_id)s
  and status in (
    'pending',
    'normalizing',
    'transcribing',
    'diarizing',
    'summarizing'
  )
"""

ConnectionFactory = Callable[[], Any]


class PostgresMeetingQueue:
    """Small queue facade around Postgres claim and status writes."""

    def __init__(self, connection_factory: ConnectionFactory) -> None:
        self._connection_factory = connection_factory

    @classmethod
    def from_database_url(
        cls, database_url: str, *, connect_kwargs: dict[str, object] | None = None
    ) -> PostgresMeetingQueue:
        kwargs = connect_kwargs or {}
        return cls(lambda: psycopg.connect(database_url, **kwargs))

    def claim_next(self) -> QueuedMeeting | None:
        """Claim the oldest non-terminal meeting under an explicit row-locking transaction."""

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor(row_factory=dict_row) as cursor:
                    cursor.execute(CLAIM_NEXT_MEETING_SQL)
                    row = cursor.fetchone()

        if row is None:
            return None
        return _meeting_from_row(row)

    def mark_normalization_started(self, meeting: QueuedMeeting) -> None:
        """Enter normalization in a short transaction before subprocess work starts."""

        self._execute(
            MARK_NORMALIZATION_STARTED_SQL,
            {"meeting_id": meeting.id},
        )

    def mark_normalization_succeeded(
        self, *, meeting: QueuedMeeting, duration_seconds: int
    ) -> None:
        """Finish the normalization-only vertical slice with persisted duration."""

        self._execute(
            MARK_NORMALIZATION_SUCCEEDED_SQL,
            {"meeting_id": meeting.id, "duration_seconds": duration_seconds},
        )

    def mark_recovery_not_implemented(self, meeting: QueuedMeeting) -> None:
        """Terminal-error a claimed later-stage row at a safe boundary for this slice."""

        if meeting.status in (MeetingStatus.PENDING, MeetingStatus.NORMALIZING):
            raise RuntimeError(
                "pending/normalizing meetings must run the normalization stage"
            )

        failed_stage = _failed_stage_for_stub(meeting.status)
        message = _recovery_stub_message(meeting.status, failed_stage)
        self.mark_failure(
            meeting=meeting,
            error_kind=ErrorKind.UNKNOWN,
            error_message=message,
            failed_at_stage=failed_stage,
        )

    def mark_failure(
        self,
        *,
        meeting: QueuedMeeting,
        error_kind: ErrorKind,
        error_message: str,
        failed_at_stage: MeetingStatus,
    ) -> None:
        self._execute(
            MARK_FAILURE_SQL,
            {
                "meeting_id": meeting.id,
                "error_kind": error_kind.value,
                "error_message": error_message,
                "failed_at_stage": failed_at_stage.value,
            },
        )

    def _execute(self, sql: str, params: dict[str, object]) -> None:
        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(sql, params)
                    if cursor.rowcount != 1:
                        raise RuntimeError(
                            f"meeting status write updated {cursor.rowcount} rows"
                        )


def _meeting_from_row(row: dict[str, object]) -> QueuedMeeting:
    return QueuedMeeting(
        id=row["id"],
        status=MeetingStatus(row["status"]),
        resume_from_stage=_maybe_status(row["resume_from_stage"]),
        transcription_progress=row["transcription_progress"],
        error_kind=_maybe_error_kind(row["error_kind"]),
        error_message=row["error_message"],
        failed_at_stage=_maybe_status(row["failed_at_stage"]),
    )


def _maybe_status(value: object) -> MeetingStatus | None:
    if value is None:
        return None
    return MeetingStatus(value)


def _maybe_error_kind(value: object) -> ErrorKind | None:
    if value is None:
        return None
    return ErrorKind(value)


def _failed_stage_for_stub(status: MeetingStatus) -> MeetingStatus:
    if status in (MeetingStatus.PENDING, MeetingStatus.NORMALIZING):
        return MeetingStatus.NORMALIZING
    return status


def _recovery_stub_message(status: MeetingStatus, failed_stage: MeetingStatus) -> str:
    if status in (MeetingStatus.PENDING, MeetingStatus.NORMALIZING):
        return (
            "Worker queue claim succeeded, but normalization is only implemented for "
            "this issue #7 normalization-only slice. A later worker item must resume "
            "from normalizing."
        )
    return (
        f"Worker recovered a meeting at {status.value!r}, but recovery beyond "
        f"{failed_stage.value!r} is not implemented in this issue #7 normalization-only slice."
    )
