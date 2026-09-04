# Video Presentation Present Mode Implementation Plan

**Goal:** Add an iPad-oriented Present Mode that keeps controls outside the recording frame, persists Pen annotations with the existing document save pipeline, uses Excalidraw's transient Laser tool, and safely switches page edit leases.

**Architecture:** `/decks/[id]/present` owns a single active page session. It acquires that page's existing document edit lease, fetches the latest scene, hydrates attachments, renders a dedicated `PresentationCanvas`, debounces saves through `saveDocumentScene`, flushes before navigation, releases the old lease, and acquires the next page. Presentation controls live outside the CSS aspect-ratio recording frame.

**Constraints:**
- Pen = `freedraw`, Laser = `laser`.
- Touch events on the recording canvas are blocked; pen/mouse remain usable.
- Wheel/pinch/pan is blocked in Present Mode.
- Page navigation is explicit buttons only.
- Navigation does not proceed if the current save fails.
- If a page lease is held elsewhere, presentation shows a blocking state instead of silently editing read-only.
- Present Mode does not add a second persistence model.

### Task 1: Presentation state helpers
- [ ] Write failing tests for page navigation, pointer filtering, and tool mapping.
- [ ] Implement pure helpers in `src/lib/presentation.ts`.

### Task 2: Presentation canvas
- [ ] Create `src/components/PresentationCanvas.tsx` using official Excalidraw APIs.
- [ ] Hide Excalidraw chrome, fit page content, apply Pen/Laser tool, block touch/wheel gestures, expose undo trigger.

### Task 3: Active-page lease/save session and route
- [ ] Add `/decks/[id]/present/page.tsx` and `PresentModeClient.tsx`.
- [ ] Acquire/heartbeat/release lease per active page.
- [ ] Fetch latest document scene and save via existing `saveDocumentScene`.
- [ ] Flush before Previous/Next/Exit.

### Task 4: Controls and baseline action
- [ ] Enable Present button in Deck Editor.
- [ ] Add large Previous, Next, Pen, Laser, Undo, More controls outside recording frame.
- [ ] More menu: Reset Current Page, Hide Controls, Exit Present Mode.

### Task 5: Verification
- [ ] Run focused tests and typecheck.
- [ ] Run full test suite.
- [ ] Run production build and `git diff --check`.
