# 📄 PRD — Internal Meeting Transcription & Summary Tool

## 1. 🧠 Overview

**Goal:**
Provide a simple, reliable internal tool that converts recorded meetings into structured, useful outputs:

```txt
audio/video → transcript → speaker mapping → summary → actionable notes
```

**Target users:**

- Internal dev/product team
- Mixed OS (macOS, Windows, Linux)
- Non-technical users should still be able to use it

---

## 2. 🎯 Problem Statement

Current pain:

- Meetings are recorded but **not easily searchable or usable**
- Manual note-taking is inconsistent
- Existing tools:
  - don’t support Serbian well
  - are expensive or overkill
  - require bots / integrations we don’t want

---

## 3. ✅ Goals

### Primary goals

- Upload or drop a meeting recording
- Automatically generate:
  - transcript
  - speaker separation (SPEAKER_00…)
  - summary
  - action items

- Allow quick mapping:

  ```
  SPEAKER_00 → Atila
  ```

- Export clean, readable output

---

### Secondary goals

- Cross-platform access (browser-based)
- Minimal setup for team members
- Fast turnaround (< few minutes per file depending on length)

---

### Non-goals (v1)

- Live transcription
- Real-time meeting assistant
- Voice identification (matching speakers automatically)
- Calendar integration

---

## 4. 👤 User Stories

### Core flow

**US-1: Upload meeting**

> As a user, I can upload an audio/video file so that it gets processed.

**US-2: Auto transcription**

> As a user, I get a transcript without doing anything else.

**US-3: Speaker mapping**

> As a user, I can rename speakers to real names.

**US-4: Structured output**

> As a user, I receive a summary, decisions, and action items.

**US-5: Export**

> As a user, I can copy or download results.

---

## 5. 🧩 Functional Requirements

## 5.1 File Handling

- Supported formats:
  - `.mp3`, `.m4a`, `.wav`, `.mp4`

- Max file size (v1): configurable (e.g. 500MB)
- Upload via:
  - UI (drag & drop)
  - OR shared folder (optional)

---

## 5.2 Processing Pipeline

For each uploaded file:

```txt
1. Normalize audio (ffmpeg)
2. Transcribe (Whisper / WhisperX)
3. Optional diarization (WhisperX)
4. Generate structured summary (LLM)
5. Store results
```

---

## 5.3 Transcript

- Output includes:
  - text
  - timestamps
  - speaker labels

Example:

```txt
SPEAKER_00 [00:00:03]
We should rethink how we use AI.

SPEAKER_01 [00:00:12]
Yes, context dumping is hurting us.
```

---

## 5.4 Speaker Mapping

UI allows:

```txt
SPEAKER_00 → [ dropdown / input ]
SPEAKER_01 → [ dropdown / input ]
```

- Updates transcript in real-time
- Mapping stored per meeting

---

## 5.5 Summary Generation

LLM generates:

```txt
- Summary
- Key points
- Decisions
- Action items (with names)
- Open questions
```

---

## 5.6 Export

Formats:

- Markdown (`.md`)
- Plain text (`.txt`)
- Copy to clipboard

---

## 6. 🖥️ UX / UI Requirements

## 6.1 Main Screen

Sections:

```txt
[ Upload / File info ]

[ Summary ]
[ Action Items ]
[ Decisions ]

[ Speaker Mapping ]

[ Transcript ]
```

---

## 6.2 Transcript

- Scrollable
- Timestamp visible
- Speaker highlighted
- (Phase 2: clickable timestamps → jump audio)

---

## 6.3 States

```txt
Uploading
Processing
Completed
Error
```

---

## 7. ⚙️ Technical Architecture

## 7.1 Frontend

- React (React Router v7 frameowrk mode)
- Handles:
  - upload
  - display
  - speaker mapping
  - export

---

## 7.2 Backend

- React Router v7 (API routes)
- Handles:
  - file upload
  - job creation
  - status tracking

---

## 7.3 Worker

- Python service
- Runs:
  - ffmpeg
  - Whisper / WhisperX
  - diarization
  - summary generation

---

## 7.4 Storage

- Files:
  - local disk (v1)

- Metadata:
  - SQLite / Postgres

---

## 8. 📦 Data Model

### Meeting

```ts
type Meeting = {
  id: string;
  fileName: string;
  status: "pending" | "processing" | "done" | "error";
  createdAt: Date;
};
```

---

### Transcript Segment

```ts
type Segment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};
```

---

### Speaker Map

```ts
type SpeakerMap = Record<string, string>;
```

---

### Summary

```ts
type Summary = {
  overview: string;
  decisions: string[];
  actionItems: {
    owner: string;
    task: string;
  }[];
  openQuestions: string[];
};
```

---

## 9. 🔐 Constraints

- No external meeting bots
- Must support Serbian + English
- Must work with large files
- Processing happens centrally (not on user machines)

---

## 10. 🚀 Success Metrics

- Time from upload → usable output
- % of meetings processed successfully
- User satisfaction (internal feedback)
- Reduction in manual note-taking

---

## 11. 📈 Roadmap

## Phase 1 (MVP)

- upload
- transcription
- speaker mapping
- summary
- export

---

## Phase 2

- audio player + timestamp sync
- highlights / topics
- better formatting

---

## Phase 3

- search across meetings
- “ask your meeting”
- speaker memory

---

## 12. 🧠 Key Insight (important)

This is NOT a transcription tool.

It is:

```txt
a system that turns conversations into decisions and actions
```
