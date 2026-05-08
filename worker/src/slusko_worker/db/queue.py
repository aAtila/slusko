"""Postgres-backed meeting queue helpers."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

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
    status = case
      when candidate.claimed_status = 'pending'
        and candidate.resume_from_stage in (
          'normalizing',
          'transcribing',
          'diarizing',
          'summarizing'
        )
        then candidate.resume_from_stage
      when candidate.claimed_status = 'pending'
        then 'normalizing'::meeting_status
      else meeting.status
    end,
    resume_from_stage = null,
    transcription_progress = case when candidate.claimed_status = 'pending' then null else meeting.transcription_progress end,
    error_kind = case when candidate.claimed_status = 'pending' then null else meeting.error_kind end,
    error_message = case when candidate.claimed_status = 'pending' then null else meeting.error_message end,
    failed_at_stage = case when candidate.claimed_status = 'pending' then null else meeting.failed_at_stage end,
    updated_at = now()
  from candidate
  where meeting.id = candidate.id
  returning
    meeting.id,
    case
      when candidate.claimed_status = 'pending'
        and candidate.resume_from_stage in (
          'normalizing',
          'transcribing',
          'diarizing',
          'summarizing'
        )
        then candidate.resume_from_stage
      else candidate.claimed_status
    end as status,
    null::meeting_status as resume_from_stage,
    case when candidate.claimed_status = 'pending' then null else candidate.transcription_progress end as transcription_progress,
    case when candidate.claimed_status = 'pending' then null else candidate.error_kind end as error_kind,
    case when candidate.claimed_status = 'pending' then null else candidate.error_message end as error_message,
    case when candidate.claimed_status = 'pending' then null else candidate.failed_at_stage end as failed_at_stage
)
select * from claimed
"""

MARK_NORMALIZATION_STARTED_SQL = """
update meetings
set
  status = 'normalizing',
  resume_from_stage = null,
  transcription_progress = null,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status in ('pending', 'normalizing')
"""

DELETE_TRANSCRIPT_SEGMENTS_SQL = """
delete from transcript_segments
where meeting_id = %(meeting_id)s
"""

MARK_TRANSCRIPTION_STARTED_SQL = """
update meetings
set
  status = 'transcribing',
  resume_from_stage = null,
  duration_seconds = coalesce(%(duration_seconds)s, duration_seconds),
  transcription_progress = 0,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status in ('normalizing', 'transcribing')
"""

MARK_TRANSCRIPTION_PROGRESS_SQL = """
update meetings
set
  transcription_progress = %(progress)s,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'transcribing'
  and (
    transcription_progress is null
    or transcription_progress < %(progress)s
  )
"""

INSERT_TRANSCRIPT_SEGMENT_SQL = """
insert into transcript_segments (
  meeting_id,
  start_seconds,
  end_seconds,
  speaker_label,
  text
) values (
  %(meeting_id)s,
  %(start_seconds)s,
  %(end_seconds)s,
  %(speaker_label)s,
  %(text)s
)
"""

MARK_TRANSCRIPTION_SUCCEEDED_SQL = """
update meetings
set
  status = 'diarizing',
  resume_from_stage = null,
  transcription_progress = 100,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'transcribing'
"""

LOAD_TRANSCRIPT_SEGMENTS_SQL = """
select
  start_seconds,
  end_seconds,
  speaker_label,
  text
from transcript_segments
where meeting_id = %(meeting_id)s
order by start_seconds asc, end_seconds asc, id asc
"""

MARK_DIARIZATION_STARTED_SQL = """
update meetings
set
  status = 'diarizing',
  resume_from_stage = null,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'diarizing'
"""

MARK_DIARIZATION_SUCCEEDED_SQL = """
update meetings
set
  status = 'summarizing',
  resume_from_stage = null,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'diarizing'
"""

MARK_SUMMARIZATION_STARTED_SQL = """
update meetings
set
  status = 'summarizing',
  resume_from_stage = null,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'summarizing'
"""

UPSERT_SUMMARY_SQL = """
insert into summaries (
  meeting_id,
  overview,
  decisions,
  action_items,
  open_questions
) values (
  %(meeting_id)s,
  %(overview)s,
  %(decisions)s,
  %(action_items)s,
  %(open_questions)s
)
on conflict (meeting_id) do update
set
  overview = excluded.overview,
  decisions = excluded.decisions,
  action_items = excluded.action_items,
  open_questions = excluded.open_questions,
  updated_at = now()
"""

MARK_SUMMARIZATION_SUCCEEDED_SQL = """
update meetings
set
  status = 'done',
  resume_from_stage = null,
  transcription_progress = 100,
  error_kind = null,
  error_message = null,
  failed_at_stage = null,
  updated_at = now()
where id = %(meeting_id)s
  and status = 'summarizing'
"""

MARK_FAILURE_SQL = """
update meetings
set
  status = 'error',
  resume_from_stage = null,
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

    def mark_transcription_started(
        self, *, meeting: QueuedMeeting, duration_seconds: int | None = None
    ) -> None:
        """Enter transcription and clear stale transcript rows for idempotent re-entry."""

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        DELETE_TRANSCRIPT_SEGMENTS_SQL,
                        {"meeting_id": meeting.id},
                    )
                    cursor.execute(
                        MARK_TRANSCRIPTION_STARTED_SQL,
                        {
                            "meeting_id": meeting.id,
                            "duration_seconds": duration_seconds,
                        },
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError(
                            f"meeting status write updated {cursor.rowcount} rows"
                        )

    def mark_transcription_progress(
        self, *, meeting: QueuedMeeting, progress: int
    ) -> None:
        """Persist non-terminal transcription progress, ignoring stale writes."""

        if progress < 0 or progress > 99:
            raise ValueError("progress must be between 0 and 99")

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        MARK_TRANSCRIPTION_PROGRESS_SQL,
                        {"meeting_id": meeting.id, "progress": progress},
                    )

    def mark_transcription_succeeded(
        self,
        *,
        meeting: QueuedMeeting,
        segments: Sequence[TranscriptSegmentDraft],
    ) -> None:
        """Replace transcript rows and hand the meeting to diarization."""

        if not segments:
            raise ValueError("at least one transcript segment is required")

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _replace_transcript_segments(cursor, meeting=meeting, segments=segments)
                    cursor.execute(
                        MARK_TRANSCRIPTION_SUCCEEDED_SQL,
                        {"meeting_id": meeting.id},
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError(
                            f"meeting status write updated {cursor.rowcount} rows"
                        )

    def load_transcript_segments(
        self, meeting: QueuedMeeting
    ) -> list[TranscriptSegmentDraft]:
        """Load transcript rows for a claimed diarization-stage meeting."""

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor(row_factory=dict_row) as cursor:
                    cursor.execute(
                        LOAD_TRANSCRIPT_SEGMENTS_SQL,
                        {"meeting_id": meeting.id},
                    )
                    rows = cursor.fetchall()

        return [_transcript_segment_from_row(row) for row in rows]

    def mark_diarization_started(self, meeting: QueuedMeeting) -> None:
        """Enter diarization without deleting transcript rows needed as input."""

        self._execute(
            MARK_DIARIZATION_STARTED_SQL,
            {"meeting_id": meeting.id},
        )

    def mark_diarization_succeeded(
        self,
        *,
        meeting: QueuedMeeting,
        segments: Sequence[TranscriptSegmentDraft],
    ) -> None:
        """Idempotently replace diarized transcript rows and hand the meeting to summarization."""

        if not segments:
            raise ValueError("at least one transcript segment is required")

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    _replace_transcript_segments(cursor, meeting=meeting, segments=segments)
                    cursor.execute(
                        MARK_DIARIZATION_SUCCEEDED_SQL,
                        {"meeting_id": meeting.id},
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError(
                            f"meeting status write updated {cursor.rowcount} rows"
                        )

    def mark_summarization_started(self, meeting: QueuedMeeting) -> None:
        """Enter summarization without deleting transcript rows needed as input."""

        self._execute(
            MARK_SUMMARIZATION_STARTED_SQL,
            {"meeting_id": meeting.id},
        )

    def mark_summarization_succeeded(
        self,
        *,
        meeting: QueuedMeeting,
        summary: SummaryDraft,
    ) -> None:
        """Upsert the structured summary and finish the meeting idempotently."""

        with self._connection_factory() as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        UPSERT_SUMMARY_SQL,
                        _summary_params(meeting=meeting, summary=summary),
                    )
                    cursor.execute(
                        MARK_SUMMARIZATION_SUCCEEDED_SQL,
                        {"meeting_id": meeting.id},
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError(
                            f"meeting status write updated {cursor.rowcount} rows"
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


def _replace_transcript_segments(
    cursor: Any,
    *,
    meeting: QueuedMeeting,
    segments: Sequence[TranscriptSegmentDraft],
) -> None:
    cursor.execute(
        DELETE_TRANSCRIPT_SEGMENTS_SQL,
        {"meeting_id": meeting.id},
    )
    for segment in segments:
        cursor.execute(
            INSERT_TRANSCRIPT_SEGMENT_SQL,
            {
                "meeting_id": meeting.id,
                "start_seconds": f"{segment.start_seconds:.3f}",
                "end_seconds": f"{segment.end_seconds:.3f}",
                "speaker_label": segment.speaker_label,
                "text": segment.text,
            },
        )


def _summary_params(*, meeting: QueuedMeeting, summary: SummaryDraft) -> dict[str, object]:
    return {
        "meeting_id": meeting.id,
        "overview": summary.overview,
        "decisions": Jsonb(_decision_payloads(summary.decisions)),
        "action_items": Jsonb(_action_item_payloads(summary.action_items)),
        "open_questions": Jsonb(_open_question_payloads(summary.open_questions)),
    }


def _decision_payloads(
    decisions: Sequence[SummaryDecisionDraft],
) -> list[dict[str, str]]:
    return [{"text": decision.text} for decision in decisions]


def _action_item_payloads(
    action_items: Sequence[SummaryActionItemDraft],
) -> list[dict[str, object]]:
    return [
        {"task": action_item.task, "owner": _owner_payload(action_item.owner)}
        for action_item in action_items
    ]


def _owner_payload(owner: SummaryActionItemOwnerDraft) -> dict[str, str]:
    if owner.kind == "unknown":
        return {"kind": "unknown"}
    if owner.value is None:
        raise ValueError(f"summary owner kind {owner.kind!r} requires value")
    return {"kind": owner.kind, "value": owner.value}


def _open_question_payloads(
    open_questions: Sequence[SummaryOpenQuestionDraft],
) -> list[dict[str, str]]:
    return [{"text": question.text} for question in open_questions]


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


def _transcript_segment_from_row(row: dict[str, object]) -> TranscriptSegmentDraft:
    return TranscriptSegmentDraft(
        start_seconds=float(row["start_seconds"]),
        end_seconds=float(row["end_seconds"]),
        speaker_label=str(row["speaker_label"]),
        text=str(row["text"]),
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
            "Worker queue claim succeeded, but normalization/transcription is only "
            "implemented for this issue #8 transcription slice. A later worker item "
            "must resume from normalizing."
        )
    return (
        f"Worker recovered a meeting at {status.value!r}, but recovery beyond "
        f"{failed_stage.value!r} is not implemented in this issue #8 transcription slice."
    )
