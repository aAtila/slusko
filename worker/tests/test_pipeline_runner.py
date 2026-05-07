from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from slusko_worker.db.models import (
    ErrorKind,
    MeetingStatus,
    QueuedMeeting,
    SummaryDraft,
    TranscriptSegmentDraft,
)
from slusko_worker.pipeline.errors import (
    DiarizationFailed,
    NormalizationFailed,
    SummarizationFailed,
    TranscriptionEmpty,
    TranscriptionFailed,
)
from slusko_worker.pipeline.runner import PipelineProcessor


MEETING_ID = UUID("00000000-0000-0000-0000-000000000001")


def queued_meeting(status: MeetingStatus = MeetingStatus.PENDING) -> QueuedMeeting:
    return QueuedMeeting(
        id=MEETING_ID,
        status=status,
        resume_from_stage=None,
        transcription_progress=None,
        error_kind=None,
        error_message=None,
        failed_at_stage=None,
    )


@dataclass(frozen=True)
class FakeNormalizationResult:
    duration_seconds: int
    normalized_path: Path = Path("/meetings/normalized.wav")


class FakeQueue:
    def __init__(self, *, progress_error: Exception | None = None) -> None:
        self.events: list[object] = []
        self.progress_error = progress_error
        self.transcript_segments: list[TranscriptSegmentDraft] = [
            TranscriptSegmentDraft(
                start_seconds=0.0,
                end_seconds=1.0,
                speaker_label="SPEAKER_00",
                text="Loaded transcript",
            )
        ]

    def mark_normalization_started(self, meeting: QueuedMeeting) -> None:
        self.events.append(("normalization_started", meeting.id))

    def mark_transcription_started(
        self, *, meeting: QueuedMeeting, duration_seconds: int | None = None
    ) -> None:
        self.events.append(("transcription_started", meeting.id, duration_seconds))

    def mark_transcription_progress(
        self, *, meeting: QueuedMeeting, progress: int
    ) -> None:
        self.events.append(("transcription_progress", meeting.id, progress))
        if self.progress_error is not None:
            raise self.progress_error

    def mark_transcription_succeeded(
        self, *, meeting: QueuedMeeting, segments: list[TranscriptSegmentDraft]
    ) -> None:
        self.transcript_segments = list(segments)
        self.events.append(("transcription_succeeded", meeting.id, segments))

    def load_transcript_segments(self, meeting: QueuedMeeting) -> list[TranscriptSegmentDraft]:
        self.events.append(("load_transcript_segments", meeting.id))
        return self.transcript_segments

    def mark_diarization_started(self, meeting: QueuedMeeting) -> None:
        self.events.append(("diarization_started", meeting.id))

    def mark_diarization_succeeded(
        self, *, meeting: QueuedMeeting, segments: list[TranscriptSegmentDraft]
    ) -> None:
        self.events.append(("diarization_succeeded", meeting.id, segments))

    def mark_summarization_started(self, meeting: QueuedMeeting) -> None:
        self.events.append(("summarization_started", meeting.id))

    def mark_summarization_succeeded(
        self, *, meeting: QueuedMeeting, summary: SummaryDraft
    ) -> None:
        self.events.append(("summarization_succeeded", meeting.id, summary))

    def mark_failure(
        self,
        *,
        meeting: QueuedMeeting,
        error_kind: ErrorKind,
        error_message: str,
        failed_at_stage: MeetingStatus,
    ) -> None:
        self.events.append(
            ("failure", meeting.id, error_kind, error_message, failed_at_stage)
        )

    def mark_recovery_not_implemented(self, meeting: QueuedMeeting) -> None:
        self.events.append(("recovery_not_implemented", meeting.id, meeting.status))


class FakeNormalizer:
    def __init__(
        self,
        result: FakeNormalizationResult | None = None,
        error: Exception | None = None,
        shared_events: list[object] | None = None,
    ) -> None:
        self.result = result
        self.error = error
        self.events: list[object] = []
        self.shared_events = shared_events

    def normalize(self, meeting: QueuedMeeting) -> FakeNormalizationResult:
        event = ("normalize", meeting.id)
        self.events.append(event)
        if self.shared_events is not None:
            self.shared_events.append(event)
        if self.error is not None:
            raise self.error
        assert self.result is not None
        return self.result


class FakeTranscriber:
    def __init__(
        self,
        segments: list[TranscriptSegmentDraft] | None = None,
        error: Exception | None = None,
        progress_updates: list[int] | None = None,
        shared_events: list[object] | None = None,
    ) -> None:
        self.segments = segments or [
            TranscriptSegmentDraft(
                start_seconds=0.0,
                end_seconds=1.0,
                speaker_label="SPEAKER_00",
                text="Hello from transcription",
            )
        ]
        self.error = error
        self.progress_updates = progress_updates or []
        self.events: list[object] = []
        self.shared_events = shared_events

    def transcribe(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        progress: object,
    ) -> list[TranscriptSegmentDraft]:
        event = ("transcribe", meeting.id, normalized_path)
        self.events.append(event)
        if self.shared_events is not None:
            self.shared_events.append(event)
        for update in self.progress_updates:
            progress(update)  # type: ignore[operator]
        if self.error is not None:
            raise self.error
        return self.segments


class FakeDiarizer:
    def __init__(
        self,
        segments: list[TranscriptSegmentDraft] | None = None,
        error: Exception | None = None,
        shared_events: list[object] | None = None,
    ) -> None:
        self.segments = segments
        self.error = error
        self.events: list[object] = []
        self.shared_events = shared_events

    def diarize(
        self,
        *,
        meeting: QueuedMeeting,
        normalized_path: Path,
        transcript_segments: list[TranscriptSegmentDraft],
    ) -> list[TranscriptSegmentDraft]:
        event = ("diarize", meeting.id, normalized_path, transcript_segments)
        self.events.append(event)
        if self.shared_events is not None:
            self.shared_events.append(event)
        if self.error is not None:
            raise self.error
        if self.segments is not None:
            return self.segments
        return [
            TranscriptSegmentDraft(
                start_seconds=segment.start_seconds,
                end_seconds=segment.end_seconds,
                speaker_label="SPEAKER_01",
                text=segment.text,
            )
            for segment in transcript_segments
        ]


class FakeSummarizer:
    def __init__(
        self,
        summary: SummaryDraft | None = None,
        error: Exception | None = None,
        shared_events: list[object] | None = None,
    ) -> None:
        self.summary = summary or SummaryDraft(
            overview="Summary overview",
            decisions=(),
            action_items=(),
            open_questions=(),
        )
        self.error = error
        self.events: list[object] = []
        self.shared_events = shared_events

    def summarize(
        self,
        *,
        meeting: QueuedMeeting,
        transcript_segments: list[TranscriptSegmentDraft],
    ) -> SummaryDraft:
        event = ("summarize", meeting.id, transcript_segments)
        self.events.append(event)
        if self.shared_events is not None:
            self.shared_events.append(event)
        if self.error is not None:
            raise self.error
        return self.summary


def make_processor(
    *,
    queue: FakeQueue,
    normalizer: FakeNormalizer | None = None,
    transcriber: FakeTranscriber | None = None,
    diarizer: FakeDiarizer | None = None,
    summarizer: FakeSummarizer | None = None,
    meetings_dir: str | Path = "/meetings",
) -> PipelineProcessor:
    return PipelineProcessor(
        queue=queue,
        normalizer=normalizer or FakeNormalizer(FakeNormalizationResult(42)),
        transcriber=transcriber or FakeTranscriber(shared_events=queue.events),
        diarizer=diarizer or FakeDiarizer(shared_events=queue.events),
        summarizer=summarizer or FakeSummarizer(shared_events=queue.events),
        meetings_dir=meetings_dir,
    )


def test_pending_meeting_normalizes_transcribes_diarizes_and_finishes() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(
        FakeNormalizationResult(duration_seconds=42, normalized_path=Path("/tmp/normalized.wav")),
        shared_events=queue.events,
    )
    segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.5,
            speaker_label="SPEAKER_00",
            text="Hello world",
        )
    ]
    diarized_segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.5,
            speaker_label="SPEAKER_01",
            text="Hello world",
        )
    ]
    transcriber = FakeTranscriber(
        segments=segments, progress_updates=[25], shared_events=queue.events
    )
    diarizer = FakeDiarizer(segments=diarized_segments, shared_events=queue.events)
    summary = SummaryDraft(
        overview="Summary overview",
        decisions=(),
        action_items=(),
        open_questions=(),
    )
    summarizer = FakeSummarizer(summary=summary, shared_events=queue.events)
    processor = make_processor(
        queue=queue,
        normalizer=normalizer,
        transcriber=transcriber,
        diarizer=diarizer,
        summarizer=summarizer,
    )

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events == [
        ("normalization_started", MEETING_ID),
        ("normalize", MEETING_ID),
        ("transcription_started", MEETING_ID, 42),
        ("transcribe", MEETING_ID, Path("/tmp/normalized.wav")),
        ("transcription_progress", MEETING_ID, 25),
        ("transcription_succeeded", MEETING_ID, segments),
        ("load_transcript_segments", MEETING_ID),
        ("diarization_started", MEETING_ID),
        ("diarize", MEETING_ID, Path("/tmp/normalized.wav"), segments),
        ("diarization_succeeded", MEETING_ID, diarized_segments),
        ("summarization_started", MEETING_ID),
        ("summarize", MEETING_ID, diarized_segments),
        ("summarization_succeeded", MEETING_ID, summary),
    ]
    assert normalizer.events == [("normalize", MEETING_ID)]


def test_transcribing_reentry_skips_normalization_and_reuses_normalized_artifact_path() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(FakeNormalizationResult(duration_seconds=42))
    transcriber = FakeTranscriber(shared_events=queue.events)
    processor = make_processor(
        queue=queue,
        normalizer=normalizer,
        transcriber=transcriber,
        meetings_dir="/data/meetings",
    )

    processor.process(queued_meeting(MeetingStatus.TRANSCRIBING))

    assert normalizer.events == []
    assert transcriber.events == [
        (
            "transcribe",
            MEETING_ID,
            Path("/data/meetings") / str(MEETING_ID) / "normalized.wav",
        )
    ]
    assert queue.events[0] == ("transcription_started", MEETING_ID, None)
    assert queue.events[-1][0] == "summarization_succeeded"


def test_progress_write_failures_do_not_abort_successful_transcription() -> None:
    queue = FakeQueue(progress_error=RuntimeError("temporary database blip"))
    transcriber = FakeTranscriber(progress_updates=[10], shared_events=queue.events)
    processor = make_processor(queue=queue, transcriber=transcriber)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1][0] == "summarization_succeeded"

def test_unexpected_normalization_error_writes_unknown_failure() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(error=OSError("filesystem refused rename"))
    processor = make_processor(queue=queue, normalizer=normalizer)

    processor.process(queued_meeting(MeetingStatus.NORMALIZING))

    assert queue.events == [
        ("normalization_started", MEETING_ID),
        (
            "failure",
            MEETING_ID,
            ErrorKind.UNKNOWN,
            "filesystem refused rename",
            MeetingStatus.NORMALIZING,
        ),
    ]


def test_normalization_failure_writes_adr_0007_error_fields() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(
        error=NormalizationFailed("ffmpeg failed: corrupt input")
    )
    processor = make_processor(queue=queue, normalizer=normalizer)

    processor.process(queued_meeting(MeetingStatus.NORMALIZING))

    assert queue.events == [
        ("normalization_started", MEETING_ID),
        (
            "failure",
            MEETING_ID,
            ErrorKind.NORMALIZATION_FAILED,
            "ffmpeg failed: corrupt input",
            MeetingStatus.NORMALIZING,
        ),
    ]


def test_transcription_failure_writes_adr_0007_error_fields() -> None:
    queue = FakeQueue()
    transcriber = FakeTranscriber(error=TranscriptionFailed("whisper crashed"))
    processor = make_processor(queue=queue, transcriber=transcriber)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.TRANSCRIPTION_FAILED,
        "whisper crashed",
        MeetingStatus.TRANSCRIBING,
    )


def test_empty_transcription_writes_distinct_non_retryable_failure() -> None:
    queue = FakeQueue()
    transcriber = FakeTranscriber(error=TranscriptionEmpty())
    processor = make_processor(queue=queue, transcriber=transcriber)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.TRANSCRIPTION_EMPTY,
        "No speech detected. The recording may be silent, music-only, or corrupted.",
        MeetingStatus.TRANSCRIBING,
    )


def test_unexpected_transcription_error_writes_unknown_failure_at_transcribing() -> None:
    queue = FakeQueue()
    transcriber = FakeTranscriber(error=RuntimeError("ctranslate exploded"))
    processor = make_processor(queue=queue, transcriber=transcriber)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.UNKNOWN,
        "ctranslate exploded",
        MeetingStatus.TRANSCRIBING,
    )


def test_diarizing_reentry_loads_existing_transcript_and_finishes_without_retranscribing() -> None:
    queue = FakeQueue()
    normalizer = FakeNormalizer(FakeNormalizationResult(duration_seconds=42))
    transcriber = FakeTranscriber(shared_events=queue.events)
    loaded_segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.0,
            speaker_label="SPEAKER_00",
            text="Loaded transcript",
        )
    ]
    diarized_segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.0,
            speaker_label="SPEAKER_01",
            text="Loaded transcript",
        )
    ]

    def load_transcript_segments(meeting: QueuedMeeting) -> list[TranscriptSegmentDraft]:
        queue.events.append(("load_transcript_segments", meeting.id))
        return loaded_segments

    queue.load_transcript_segments = load_transcript_segments  # type: ignore[method-assign]
    diarizer = FakeDiarizer(segments=diarized_segments, shared_events=queue.events)
    processor = make_processor(
        queue=queue,
        normalizer=normalizer,
        transcriber=transcriber,
        diarizer=diarizer,
        meetings_dir="/data/meetings",
    )

    processor.process(queued_meeting(MeetingStatus.DIARIZING))

    assert normalizer.events == []
    assert transcriber.events == []
    assert queue.events == [
        ("load_transcript_segments", MEETING_ID),
        ("diarization_started", MEETING_ID),
        (
            "diarize",
            MEETING_ID,
            Path("/data/meetings") / str(MEETING_ID) / "normalized.wav",
            loaded_segments,
        ),
        ("diarization_succeeded", MEETING_ID, diarized_segments),
        ("summarization_started", MEETING_ID),
        ("summarize", MEETING_ID, diarized_segments),
        (
            "summarization_succeeded",
            MEETING_ID,
            SummaryDraft(
                overview="Summary overview",
                decisions=(),
                action_items=(),
                open_questions=(),
            ),
        ),
    ]


def test_diarization_failure_writes_adr_0007_error_fields() -> None:
    queue = FakeQueue()
    diarizer = FakeDiarizer(error=DiarizationFailed("pyannote rejected audio"))
    processor = make_processor(queue=queue, diarizer=diarizer)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.DIARIZATION_FAILED,
        "pyannote rejected audio",
        MeetingStatus.DIARIZING,
    )


def test_unexpected_diarization_error_writes_unknown_failure_at_diarizing() -> None:
    queue = FakeQueue()
    diarizer = FakeDiarizer(error=RuntimeError("pyannote exploded"))
    processor = make_processor(queue=queue, diarizer=diarizer)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.UNKNOWN,
        "pyannote exploded",
        MeetingStatus.DIARIZING,
    )


def test_empty_transcript_at_diarizing_maps_to_diarization_failure() -> None:
    queue = FakeQueue()

    def load_transcript_segments(meeting: QueuedMeeting) -> list[TranscriptSegmentDraft]:
        queue.events.append(("load_transcript_segments", meeting.id))
        return []

    queue.load_transcript_segments = load_transcript_segments  # type: ignore[method-assign]
    diarizer = FakeDiarizer(
        error=DiarizationFailed("diarization requires at least one transcript segment"),
        shared_events=queue.events,
    )
    processor = make_processor(queue=queue, diarizer=diarizer)

    processor.process(queued_meeting(MeetingStatus.DIARIZING))

    assert queue.events == [
        ("load_transcript_segments", MEETING_ID),
        ("diarization_started", MEETING_ID),
        (
            "diarize",
            MEETING_ID,
            Path("/meetings") / str(MEETING_ID) / "normalized.wav",
            [],
        ),
        (
            "failure",
            MEETING_ID,
            ErrorKind.DIARIZATION_FAILED,
            "diarization requires at least one transcript segment",
            MeetingStatus.DIARIZING,
        ),
    ]


def test_summarizing_reentry_loads_existing_transcript_and_finishes_without_rerunning_prior_stages() -> None:
    queue = FakeQueue()
    loaded_segments = [
        TranscriptSegmentDraft(
            start_seconds=0.0,
            end_seconds=1.0,
            speaker_label="SPEAKER_00",
            text="Loaded transcript",
        )
    ]
    summary = SummaryDraft(
        overview="Loaded summary",
        decisions=(),
        action_items=(),
        open_questions=(),
    )

    def load_transcript_segments(meeting: QueuedMeeting) -> list[TranscriptSegmentDraft]:
        queue.events.append(("load_transcript_segments", meeting.id))
        return loaded_segments

    queue.load_transcript_segments = load_transcript_segments  # type: ignore[method-assign]
    normalizer = FakeNormalizer(FakeNormalizationResult(duration_seconds=42))
    transcriber = FakeTranscriber(shared_events=queue.events)
    diarizer = FakeDiarizer(shared_events=queue.events)
    summarizer = FakeSummarizer(summary=summary, shared_events=queue.events)
    processor = make_processor(
        queue=queue,
        normalizer=normalizer,
        transcriber=transcriber,
        diarizer=diarizer,
        summarizer=summarizer,
    )

    processor.process(queued_meeting(MeetingStatus.SUMMARIZING))

    assert normalizer.events == []
    assert transcriber.events == []
    assert diarizer.events == []
    assert queue.events == [
        ("load_transcript_segments", MEETING_ID),
        ("summarization_started", MEETING_ID),
        ("summarize", MEETING_ID, loaded_segments),
        ("summarization_succeeded", MEETING_ID, summary),
    ]


def test_summarization_failure_writes_adr_0007_error_fields() -> None:
    queue = FakeQueue()
    summarizer = FakeSummarizer(
        error=SummarizationFailed("OpenRouter rejected the transcript"),
        shared_events=queue.events,
    )
    processor = make_processor(queue=queue, summarizer=summarizer)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.SUMMARIZATION_FAILED,
        "OpenRouter rejected the transcript",
        MeetingStatus.SUMMARIZING,
    )


def test_summarization_config_missing_writes_config_missing_at_summarizing() -> None:
    queue = FakeQueue()
    summarizer = FakeSummarizer(
        error=SummarizationFailed("OPENROUTER_API_KEY is required", config_missing=True),
        shared_events=queue.events,
    )
    processor = make_processor(queue=queue, summarizer=summarizer)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.CONFIG_MISSING,
        "OPENROUTER_API_KEY is required",
        MeetingStatus.SUMMARIZING,
    )


def test_unexpected_summarization_error_writes_unknown_failure_at_summarizing() -> None:
    queue = FakeQueue()
    summarizer = FakeSummarizer(
        error=RuntimeError("json parser exploded"),
        shared_events=queue.events,
    )
    processor = make_processor(queue=queue, summarizer=summarizer)

    processor.process(queued_meeting(MeetingStatus.PENDING))

    assert queue.events[-1] == (
        "failure",
        MEETING_ID,
        ErrorKind.UNKNOWN,
        "json parser exploded",
        MeetingStatus.SUMMARIZING,
    )


def test_transcript_load_failure_at_summarizing_marks_summarization_stage() -> None:
    queue = FakeQueue()

    def load_transcript_segments(meeting: QueuedMeeting) -> list[TranscriptSegmentDraft]:
        queue.events.append(("load_transcript_segments", meeting.id))
        raise RuntimeError("database unavailable")

    queue.load_transcript_segments = load_transcript_segments  # type: ignore[method-assign]
    processor = make_processor(queue=queue)

    processor.process(queued_meeting(MeetingStatus.SUMMARIZING))

    assert queue.events == [
        ("load_transcript_segments", MEETING_ID),
        (
            "failure",
            MEETING_ID,
            ErrorKind.UNKNOWN,
            "database unavailable",
            MeetingStatus.SUMMARIZING,
        ),
    ]
