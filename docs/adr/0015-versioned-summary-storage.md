# ADR 0015 — Versioned Summary storage

**Status:** Accepted
**Date:** 2026-05-08

## Context

Issue #13 changed the Summary editing model from direct field editing to AI-assisted Summary revision. That means each revision can produce a complete replacement structured Summary while users still need a stable “latest Summary” to read on the Meeting page.

## Decision

Slusko stores Summaries as versions from the start. The initial pipeline-generated Summary is inserted into `summary_versions` as Summary version 1, and pipeline completion sets `meetings.latest_summary_version_id` to that row. Every successful AI Summary revision creates the next per-Meeting `version_number` and marks it as the latest version for that Meeting. The existing one-row-per-Meeting `summaries` shape should be replaced by versioned storage rather than kept as a duplicated latest read model. The latest pointer lives on `meetings.latest_summary_version_id`, so the Meeting directly identifies the Summary version shown in v1.

## Considered Options

- Keep `summaries` as the latest Summary and add a `summary_versions` history table. Rejected because it duplicates the same structured Summary in two places and makes “which row is canonical?” a permanent question.
- Replace `summaries` with versioned storage plus an explicit latest pointer. Accepted because it models the domain directly: a Meeting has many Summary versions and exactly one latest Summary version.

## Consequences

- The Meeting page still exposes only the latest Summary in v1; there is no revision-history UI, audit log, or per-user attribution.
- The schema and loader code must read through the latest Summary version rather than assuming `summaries.meeting_id` is the primary key.
- Summary revision requests store the base Summary version that was latest at submission time; the worker revises that base version rather than resolving “latest” later.
- Summary versions carry minimal internal provenance: `source = initial | ai_revision | reset`, a nullable `source_revision_request_id` for AI-produced versions, and a nullable `source_summary_version_id` for reset-produced versions.
- Successful Summary revision writes must be atomic: before applying, verify the request's base Summary version is still the Meeting's latest; if not, mark the request failed, log the stale-base reason, and leave the Summary unchanged. Otherwise insert the new Summary version and update the Meeting’s latest-version pointer together.
- Resetting to the initial Summary is also append-only: copy version 1 into a new highest-numbered Summary version and point the Meeting at that new version, rather than moving the latest pointer backward.
- Reset is a synchronous web action because it is a DB-only copy/update operation, not worker or LLM work.
- Deleting a Meeting cascades to its Summary versions and Summary revision requests; there is no retained audit/history outside the Meeting.
