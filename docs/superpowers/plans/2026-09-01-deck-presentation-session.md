# Deck Presentation Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deck Editor and Present Mode one reliable Deck-scoped editing session with save-before-Present, Reset View, locked presentation camera, and fullscreen/standalone-app support.

**Architecture:** Add a Deck-specific lease subsystem parallel to the existing Document lease subsystem, and allow Deck Page saves to authenticate against the owning Deck lease. Deck Editor owns lease acquisition and passes Deck lease credentials into its embedded page editor; Present Mode reacquires the same logical Deck session from session-scoped credentials. Keep standalone Documents unchanged. Add explicit view-reset/fullscreen utilities at the presentation UI layer.

**Tech Stack:** Next.js App Router, React, TypeScript, SQLite, Vitest, Excalidraw 0.18.1.

**Spec:** `docs/superpowers/specs/2026-09-01-deck-presentation-session-design.md`

## Global Constraints

- Standalone Documents continue to use Document-scoped edit leases.
- One live Deck lease blocks all Page backing Documents in that Deck from other browsing contexts, including another tab for the same user.
- Deck Editor and Present Mode reuse the same Deck lease session across route transitions.
- Present navigation occurs only after a successful active-Page save flush.
- Deck Editor allows pan/zoom and exposes Reset View; Present Mode does not allow user viewport manipulation.
- Fullscreen support is optional at runtime and must never block Present Mode.
- Installed-app metadata must not introduce offline-editing semantics.

---

### Task 1: Deck lease model and API

**Files:**
- Modify: `src/lib/db.ts`
- Create: `src/lib/deck_edit_lease.ts`
- Create: `src/app/api/decks/[id]/lease/route.ts`
- Create: `tests/deck_edit_lease.test.ts`
- Create: `tests/deck_edit_lease_route.test.ts`

**Interfaces:**
- Produces `DeckLeaseCredentials = { clientId: string; leaseToken: string; generation: number }` compatible in shape with existing lease credentials.
- Produces acquire, heartbeat, release, request-takeover, poll-takeover functions scoped by `deckId`.
- Produces `assertActiveDeckEditLease({ deckId, userId, role, clientId, leaseToken, generation })`.

- [ ] Write failing tests for single-holder fencing, same-context re-entry, same-user second-tab blocking, heartbeat, release, takeover, and resetDb cleanup.
- [ ] Run focused tests and verify RED.
- [ ] Add `deck_edit_leases` schema and implementation by adapting existing lease semantics without changing Document lease behavior.
- [ ] Add `/api/decks/[id]/lease` route mirroring the Document lease action contract.
- [ ] Run focused tests and typecheck until GREEN.
- [ ] Commit as `feat: add deck edit lease`.

### Task 2: Authorize Page saves with Deck lease

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/versions.ts`
- Modify: `src/app/api/documents/[id]/save/route.ts`
- Modify: `src/app/api/documents/[id]/scene/route.ts`
- Modify: `src/lib/client_save.ts`
- Modify: attachment upload authorization only if current route requires Document lease credentials
- Create or modify: `tests/deck_edit_lease.test.ts`, `tests/client_save_pipeline.test.ts`, route tests

**Interfaces:**
- Client save accepts either `{ scope: "document", credentials }` or `{ scope: "deck", deckId, credentials }` while preserving existing Document callers.
- Server verifies that `documentId` belongs to `deckId` before Deck lease authorization succeeds.

- [ ] Write failing tests proving a valid Deck lease can save its Page without a Document lease and cannot save another Deck's Page or a standalone Document.
- [ ] Run focused tests and verify RED.
- [ ] Add lease-scope parsing and server authorization with minimal branching around the existing save implementation.
- [ ] Update client save payload construction without changing standalone Document behavior.
- [ ] Run focused tests and typecheck until GREEN.
- [ ] Commit as `feat: authorize deck page saves`.

### Task 3: Deck Editor owns the Deck lease and gates Present on save

**Files:**
- Create: `src/lib/client_deck_edit_lease.ts`
- Modify: `src/app/decks/[id]/DeckEditorClient.tsx`
- Modify: `src/app/decks/[id]/EmbeddedPageEditor.tsx`
- Modify: `src/app/documents/[id]/EditorClient.tsx`
- Modify: `tests/video_presentation_mvp.test.ts`
- Create focused client/model tests as needed

**Interfaces:**
- `EditorClient` embedded mode accepts external Deck lease credentials and skips Document lease acquisition/release/heartbeat.
- `EditorClientControl.flush()` remains the save barrier; Deck Editor owns Deck lease lifecycle.
- Present action becomes an async handler: flush, persist Deck credentials, then route to Present.

- [ ] Write failing tests/source contracts for external lease mode and Present navigation only after successful `flush()`.
- [ ] Run focused tests and verify RED.
- [ ] Add client Deck lease helpers and Deck Editor acquire/heartbeat/blocking lifecycle.
- [ ] Add external lease mode to embedded EditorClient with Deck-scoped saves.
- [ ] Replace Present link with an async button that does not navigate on flush failure.
- [ ] Ensure baseline and snapshot actions call `flush()` first and include Deck lease credentials where required.
- [ ] Run focused tests and typecheck until GREEN.
- [ ] Commit as `feat: keep deck lease through present`.

### Task 4: Present Mode uses the Deck lease across Pages

**Files:**
- Modify: `src/app/decks/[id]/present/PresentModeClient.tsx`
- Modify: `tests/video_presentation_mvp.test.ts`
- Add focused Present-mode tests if useful

**Interfaces:**
- Present Mode acquires/re-enters one Deck lease once, heartbeats it, and uses it for all Page saves.
- Page navigation saves current Page but does not release/reacquire a lease per Page.
- Exit to Deck Editor retains credentials for same-context re-entry; leaving the Deck workflow uses best-effort release.

- [ ] Write failing tests/source contracts proving no per-Page acquire/release and Deck lease save payload use.
- [ ] Run focused tests and verify RED.
- [ ] Replace per-Page Document lease lifecycle with one Deck lease lifecycle.
- [ ] Preserve save-before-navigation and save-before-exit behavior.
- [ ] Adapt Reset Current to operate under the active Deck lease without self-blocking.
- [ ] Run focused tests and typecheck until GREEN.
- [ ] Commit as `feat: use deck lease in present mode`.

### Task 5: Reset View and fixed Present camera

**Files:**
- Modify: `src/components/ExcalidrawCanvas.tsx`
- Modify: `src/app/documents/[id]/EditorClient.tsx`
- Modify: `src/app/decks/[id]/DeckEditorClient.tsx`
- Modify: `src/components/PresentationCanvas.tsx`
- Modify: `src/lib/recording_frame.ts`
- Modify: `tests/recording_frame.test.ts`

**Interfaces:**
- `EditorClientControl.resetView()` fits the shared recording frame without altering scene content.
- Present Mode reasserts the same recording-frame fit when Excalidraw reports scroll/zoom changes and blocks wheel/touch viewport gestures.

- [ ] Write failing tests for reusable recording-frame fit parameters and source contracts for Reset View/fixed Present camera.
- [ ] Run focused tests and verify RED.
- [ ] Expose Reset View through ExcalidrawCanvas -> EditorClient -> DeckEditor control.
- [ ] Harden Present Mode against wheel, pinch, pan, and unexpected viewport drift.
- [ ] Run focused tests and typecheck until GREEN.
- [ ] Commit as `feat: lock presentation viewport`.

### Task 6: Fullscreen and standalone web-app metadata

**Files:**
- Modify or create: `src/app/manifest.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/decks/[id]/present/PresentModeClient.tsx`
- Create: `src/lib/presentation_fullscreen.ts`
- Create: `tests/presentation_fullscreen.test.ts`

**Interfaces:**
- Pure helpers determine whether fullscreen is supported, active, or running standalone.
- Present UI exposes enter/exit fullscreen only where meaningful.
- Manifest declares standalone presentation-capable display behavior and existing app identity/icons where available.

- [ ] Write failing helper/manifest/source tests.
- [ ] Run focused tests and verify RED.
- [ ] Add optional fullscreen helper and Present UI action with non-blocking failure handling.
- [ ] Add Next.js manifest metadata for standalone launch without adding offline service-worker behavior.
- [ ] Run focused tests and typecheck until GREEN.
- [ ] Commit as `feat: add fullscreen presentation app mode`.

### Task 7: Integrate Deck lease with baseline/reset and finish validation

**Files:**
- Modify: `src/app/api/decks/[id]/baseline/route.ts`
- Modify: `src/app/api/decks/[id]/baseline/reset/route.ts`
- Modify: snapshot routes as needed
- Modify: `src/lib/presentation_snapshots.ts`
- Modify: `docs/features/video-presentation/TODO.md`
- Modify: relevant tests

**Interfaces:**
- Baseline/reset mutations accept and validate the active Deck lease for normal Deck workflows.
- Reset no longer rejects the current Deck session because of legacy per-Document lease checks when the operation is authorized by that Deck lease.

- [ ] Write failing tests for baseline/reset under a live Deck lease and blocking from a non-holder.
- [ ] Run focused tests and verify RED.
- [ ] Add Deck lease authorization and remove self-conflicting per-Page lease behavior from normal Deck paths while preserving standalone safety.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` fresh.
- [ ] Mark the four presentation-session-hardening TODOs complete only after the fresh verification succeeds.
- [ ] Commit as `feat: harden deck presentation session`.
