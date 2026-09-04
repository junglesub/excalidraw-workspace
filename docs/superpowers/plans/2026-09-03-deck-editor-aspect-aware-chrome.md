# Deck Editor Aspect-Aware Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deck Edit chrome follow the Deck aspect ratio, using side rails for 9:16 and compact top/bottom chrome for 16:9 while preserving editor behavior.

**Architecture:** Add a small editor-chrome orientation contract derived only from `deck.aspectRatio`. DeckEditorClient owns placement of Deck-level controls; the embedded editor receives `horizontal` or `vertical` toolbar orientation and renders Excalidraw controls accordingly without CSS rotation. Existing save, lease, recording-frame, and Present behavior stay unchanged.

**Tech Stack:** Next.js 15, React, TypeScript, Tailwind CSS, Excalidraw, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-deck-editor-aspect-aware-chrome-design.md`

## Global Constraints
- Orientation is derived from `deck.aspectRatio`, never viewport dimensions.
- `9:16` must free persistent top/bottom editor space by moving navigation, snapshots, utilities, and the Excalidraw toolbar to side rails.
- `16:9` must keep the Excalidraw toolbar horizontal and merge snapshots/navigation into a compact bottom row.
- Do not rotate toolbar DOM with CSS.
- Standalone document editing must remain unchanged.
- Preserve existing Deck lease, autosave, recording-frame camera, snapshot, and Laser settings behavior.

---

### Task 1: Aspect-aware chrome model

**Files:**
- Modify: `src/lib/deck_editor.ts`
- Test: `tests/deck_editor_model.test.ts`

**Interfaces:**
- Produces: a pure helper mapping `DeckAspectRatio` to portrait/landscape editor chrome mode and toolbar orientation.

- [ ] Write RED tests for `9:16 -> portrait/vertical` and `16:9 -> landscape/horizontal`.
- [ ] Run focused tests and confirm the expected failure.
- [ ] Implement the minimal helper.
- [ ] Run focused tests to GREEN.

### Task 2: Embedded Excalidraw toolbar orientation contract

**Files:**
- Modify: `src/app/decks/[id]/EmbeddedPageEditor.tsx`
- Modify: `src/app/documents/[id]/EditorClient.tsx`
- Modify: `src/components/ExcalidrawCanvas.tsx`
- Test: `tests/deck_editor_session.test.ts`

**Interfaces:**
- Consumes: Task 1 orientation.
- Produces: embedded-only toolbar layout prop supporting `horizontal | vertical`.

- [ ] Add RED source/behavior tests proving Deck embedded editor passes toolbar orientation and standalone editor defaults remain unchanged.
- [ ] Verify RED.
- [ ] Implement explicit horizontal/vertical toolbar layout without CSS rotation.
- [ ] Ensure dropdowns/tooltips remain unrotated and only one Excalidraw toolbar is visible.
- [ ] Run focused tests and typecheck.

### Task 3: Portrait 9:16 Deck chrome

**Files:**
- Modify: `src/app/decks/[id]/DeckEditorClient.tsx`
- Test: `tests/deck_editor_session.test.ts`

**Interfaces:**
- Consumes: Task 1 chrome mode and Task 2 vertical toolbar orientation.

- [ ] Add RED tests for compact header, left page/navigation rail, right utility/snapshot rail, and absence of persistent bottom bars in portrait mode.
- [ ] Verify RED.
- [ ] Refactor Deck-level actions into reusable compact control groups as needed.
- [ ] Implement portrait layout.
- [ ] Keep Named Snapshots behind a compact side trigger/panel.
- [ ] Run focused tests and typecheck.

### Task 4: Landscape 16:9 compact chrome

**Files:**
- Modify: `src/app/decks/[id]/DeckEditorClient.tsx`
- Test: `tests/deck_editor_session.test.ts`

**Interfaces:**
- Consumes: Task 1 chrome mode and Task 2 horizontal toolbar orientation.

- [ ] Add RED tests for horizontal editor tools and one compact bottom row containing page navigation plus snapshot access.
- [ ] Verify RED.
- [ ] Implement landscape layout and remove the current two-row snapshot/footer stack.
- [ ] Keep header compact and non-wrapping under normal desktop widths.
- [ ] Run focused tests and typecheck.

### Task 5: Documentation and full verification

**Files:**
- Modify: `docs/features/video-presentation/TODO.md`
- Modify: `docs/features/video-presentation/design.md` if editor chrome behavior is documented there.

- [ ] Mark the new aspect-aware editor chrome TODO items complete only after implementation.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Confirm Present bundle has no material regression.
- [ ] Commit the implementation.
- [ ] Restart dev server on port 3001 and verify Ready + expected HTTP redirect.
- [ ] Confirm `git status --short` is clean.
