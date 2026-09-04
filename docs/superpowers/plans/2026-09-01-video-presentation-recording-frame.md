# Video Presentation Recording Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deck preparation and Present Mode use one shared recording-frame scene region so what the user frames while editing is exactly what Present Mode records.

**Architecture:** Define immutable scene-space recording-frame bounds in `src/lib/recording_frame.ts`: `16:9 = { x: 0, y: 0, width: 1600, height: 900 }`, `9:16 = { x: 0, y: 0, width: 900, height: 1600 }`. `ExcalidrawCanvas` renders a non-persistent overlay for that scene rectangle and initially fits it with surrounding editing space. `PresentationCanvas` fits the same scene rectangle to its aspect-ratio viewport rather than fitting existing elements.

**Tech Stack:** React 18, TypeScript, `@excalidraw/excalidraw` 0.18.1, Vitest.

**Spec:** `docs/features/video-presentation/design.md`

## Global Constraints

- Recording frame is UI metadata, never a persisted Excalidraw element.
- Editing outside the frame remains possible in Deck Editor.
- Present Mode fits the frame, not the current element bounds.
- Standalone Documents do not show a recording frame.

---

### Task 1: Shared frame model

**Files:**
- Create: `src/lib/recording_frame.ts`
- Create: `tests/recording_frame.test.ts`

**Interfaces:**
- `recordingFrameForAspectRatio(aspectRatio)` returns the exact scene-space rectangle.
- `recordingFrameTarget(aspectRatio)` returns a non-persisted Excalidraw-compatible rectangle target for `scrollToContent`.

- [x] Write tests for exact 1600x900 and 900x1600 bounds and origin.
- [x] Verify RED.
- [x] Implement the model.
- [x] Verify GREEN.

### Task 2: Deck Editor overlay

**Files:**
- Modify: `src/components/ExcalidrawCanvas.tsx`
- Modify: `src/app/documents/[id]/EditorClient.tsx`
- Modify: `src/app/decks/[id]/EmbeddedPageEditor.tsx`
- Modify: `src/app/decks/[id]/DeckEditorClient.tsx`

**Interfaces:**
- `ExcalidrawCanvas` accepts optional `recordingFrameAspectRatio`.
- When provided, it fits the shared frame on initial mount and renders a pointer-events-none border transformed from scene coordinates as pan/zoom changes.
- Embedded Deck editor passes the Deck aspect ratio; standalone document editor does not.

- [x] Add source-contract assertions that Deck embedded editing passes the ratio and standalone usage remains optional.
- [x] Verify RED.
- [x] Implement overlay and initial fit using public Excalidraw APIs.
- [x] Verify focused tests and typecheck GREEN.

### Task 3: Present Mode exact frame fit

**Files:**
- Modify: `src/components/PresentationCanvas.tsx`
- Modify: `src/app/decks/[id]/present/PresentModeClient.tsx`
- Modify: `tests/presentation_model.test.ts`

**Interfaces:**
- `PresentationCanvas` receives Deck aspect ratio.
- It always calls `scrollToContent` with the shared recording-frame target after hydration, including blank pages.
- Existing elements outside the frame do not affect presentation framing.

- [x] Add source/model assertions for shared frame usage in Present Mode.
- [x] Verify RED.
- [x] Implement exact frame fit.
- [x] Verify focused tests and typecheck GREEN.

### Task 4: Verification and TODO update

- [x] Run full tests.
- [x] Run typecheck.
- [x] Run production build.
- [x] Run `git diff --check`.
- [x] Mark the three recording-frame TODO items complete only after verification.
