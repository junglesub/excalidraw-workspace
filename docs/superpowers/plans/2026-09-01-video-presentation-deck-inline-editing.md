# Video Presentation Deck Inline Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deck Pages directly editable inside the Deck Editor, keep Page backing Documents out of standalone Dashboard listings, and make Page lifecycle ownership explicit.

**Architecture:** Reuse the existing `EditorClient` lease/save/recovery pipeline through an embedded mode instead of creating another editor session implementation. The Deck Editor fetches the active Page's backing Document metadata/scene and mounts the embedded editor keyed by document ID. Dashboard document queries exclude any document referenced by `deck_pages`; Page deletion continues to own backing-document cleanup.

**Tech Stack:** Next.js 15 App Router, React 18, TypeScript, Node `node:sqlite`, Vitest, existing Excalidraw editor and edit-lease/save pipeline.

**Spec:** `docs/features/video-presentation/design.md`

## Global Constraints

- Page and Document remain distinct concepts.
- A Page backing Document is an implementation detail inside Deck workflows.
- No second save, attachment, recovery, version, or lease pipeline.
- Standalone Documents remain unchanged.
- Page deletion owns backing Document deletion.

---

### Task 1: Hide Page backing Documents from standalone listings

**Files:**
- Modify: `src/lib/documents.ts`
- Modify: `tests/documents.test.ts`

**Interfaces:**
- `listMyDocuments(userId)` excludes documents referenced by `deck_pages.document_id`.
- `listSharedDocuments(userId)` excludes documents referenced by `deck_pages.document_id`.
- Trash/admin behavior remains administrative and is not part of normal standalone listing semantics.

- [x] Write failing tests creating one standalone Document and one Deck Page backing Document and assert only the standalone Document is listed.
- [x] Run focused tests and verify RED.
- [x] Implement query filtering with `NOT EXISTS (SELECT 1 FROM deck_pages ...)`.
- [x] Run focused tests and verify GREEN.

### Task 2: Embedded existing Document editor

**Files:**
- Modify: `src/app/documents/[id]/EditorClient.tsx`
- Create: `src/app/decks/[id]/EmbeddedPageEditor.tsx`
- Modify: `src/app/decks/[id]/page.tsx`
- Modify: `src/app/decks/[id]/DeckEditorClient.tsx`
- Test: `tests/deck_editor_model.test.ts`

**Interfaces:**
- `EditorClient` gains `embedded?: boolean` and optional `onDocumentSaved?: () => void`.
- Embedded mode suppresses standalone Document header actions and document deletion/rename UI while retaining lease, autosave, manual keyboard save, history/recovery internals, and canvas.
- `EmbeddedPageEditor` fetches `/api/documents/:documentId`, mounts `EditorClient` keyed by document ID, and reports loading/errors locally.
- Deck page selection directly changes the mounted editable canvas.

- [x] Add failing UI-model/source contract tests that encode direct inline editing and removal of the `Edit page` link.
- [x] Verify RED.
- [x] Implement minimal embedded mode and Deck wiring.
- [x] Verify focused tests and typecheck GREEN.

### Task 3: Page lifecycle ownership contract

**Files:**
- Modify: `tests/decks.test.ts`
- Modify only if needed: `src/lib/decks.ts`
- Modify: `docs/features/video-presentation/TODO.md`

**Interfaces:**
- Deleting a Page removes its `deck_pages` row and backing Document.
- Deleting a Deck removes all Page backing Documents.
- Normal Dashboard UI cannot independently manage backing Documents because they are excluded from standalone listings.

- [x] Add/strengthen failing lifecycle assertions for backing Document cleanup.
- [x] Verify RED if behavior is missing; otherwise document that the existing implementation satisfies the contract with fresh passing evidence.
- [x] Make the smallest production change if required.
- [x] Mark the five Deck editing UX alignment TODO items complete only after focused and full verification.

### Task 4: Verification

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `git diff --check` and inspect `git status --short`.
