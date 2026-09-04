# Video Presentation Snapshots and Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add permanent named page snapshots and deck-level recording baselines with safe current/all-page reset.

**Architecture:** Keep snapshot scene data in the existing `document_versions` table and add a pinned flag so permanent checkpoints are excluded from ordinary 20-version retention. Named snapshots and recording baseline rows reference pinned document versions. Baseline reset reuses the existing restore semantics, rejects pages with an active edit lease, validates the whole baseline first, then restores all participating pages inside one DB transaction.

**Tech Stack:** Node SQLite, TypeScript, Next.js App Router, Vitest.

**Spec:** `docs/features/video-presentation/design.md`

## Global Constraints
- Named snapshots remain until explicitly deleted.
- One active recording baseline per Deck; prior baselines remain preserved.
- Reset All restores baseline page content but leaves pages created after the baseline in place.
- Reset does not recreate pages deleted after the baseline.
- Reset All must validate before applying changes and must not silently leave a mixed state.

---

### Task 1: Pinned document versions
- [ ] Add failing tests proving pinned versions survive normal retention while ordinary history stays bounded.
- [ ] Add `is_pinned` migration/type support and pinned snapshot creation.
- [ ] Keep pinned versions out of retention trimming.

### Task 2: Named snapshots and recording baseline domain
- [ ] Add failing tests for permanent named snapshots, active baseline creation, previous baseline preservation, pages added after baseline, and reset current/all.
- [ ] Add schema and `src/lib/presentation_snapshots.ts` domain functions.
- [ ] Reject baseline reset when a target document has an active edit lease.

### Task 3: HTTP and Deck Editor controls
- [ ] Add failing route tests for named snapshot and baseline endpoints.
- [ ] Add APIs and Deck Editor controls for Set Baseline, Reset Current, Reset All, and page named snapshots.
- [ ] Run typecheck and focused tests.

### Task 4: Full verification
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
