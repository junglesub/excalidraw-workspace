# Video Presentation MVP

## Goal

Turn the existing Excalidraw workspace into a presentation-oriented workspace for recording YouTube videos and Shorts.

The product should sit between a slide deck and a live whiteboard:

- prepare pages like slides
- use Excalidraw on each page
- move page by page while recording
- annotate live with Apple Pencil
- use a laser pointer for transient emphasis
- restore pages to a known pre-recording state after a take

The primary workflow is:

`Prepare -> Save Recording Baseline -> Present -> Annotate -> Finish Take -> Keep or Reset -> Retake`

The MVP is intentionally not a PowerPoint replacement. It is optimized for recording explanatory videos with minimal UI covering the content.

## Primary Use Cases

### YouTube landscape video

1. Create a 16:9 deck.
2. Add several pages.
3. Mostly place images on each page and optionally add Excalidraw elements.
4. Save a recording baseline.
5. Enter Present Mode.
6. Move forward and backward using large buttons.
7. Annotate using Apple Pencil or highlight using the laser tool.
8. Exit Present Mode.
9. Keep the annotations or reset the current page / all pages to the recording baseline.
10. Record another take if needed.

### Shorts / vertical video

The same workflow is used with a 9:16 recording frame.

## Core Concepts

### Deck

A Deck is the presentation-level container.

Proposed fields:

```ts
type Deck = {
  id: string;
  title: string;
  aspectRatio: "16:9" | "9:16";
  pageOrder: string[];
  activeRecordingBaselineId?: string;
  createdAt: string;
  updatedAt: string;
};
```

### Page

Each Page should wrap an independent existing Excalidraw document/scene instead of introducing a new scene storage format.

This is intentional so the feature can reuse the existing document storage, autosave, attachments, thumbnails, version history, edit lease, and restore behavior.

```ts
type Page = {
  id: string;
  deckId: string;
  documentId: string;
  title: string;
  order: number;
  thumbnail?: string;
};
```

### Named Snapshot

A named snapshot is a permanent, user-controlled checkpoint for a page.

Unlike ordinary retained history, named snapshots should not be deleted by normal history retention. They remain until the user explicitly deletes them.

Examples:

- Clean
- Diagram Complete
- Before Recording
- Alternate Layout

```ts
type NamedSnapshot = {
  id: string;
  pageId: string;
  name: string;
  snapshotId: string;
  createdAt: string;
};
```

### Recording Baseline

A recording baseline is a Deck-level checkpoint consisting of one snapshot per current page.

```ts
type RecordingBaseline = {
  id: string;
  deckId: string;
  createdAt: string;
  pages: Array<{
    pageId: string;
    snapshotId: string;
  }>;
};
```

There is one active baseline per Deck.

When a new baseline is created, the previous one should be preserved as a previous baseline / named checkpoint rather than immediately destroyed.

## Page Model Decision

For the MVP:

> One Page = one independent Excalidraw document/scene.

This is preferred over putting all pages into frames inside one Excalidraw scene because it gives simpler isolation for:

- save state
- thumbnails
- restore
- snapshot management
- page duplication
- per-page undo/history
- reset current page
- reset all pages to baseline

It also maximizes reuse of the current repository architecture.

## Deck Editor

The Deck Editor is the preparation view and the primary editing surface for Deck pages.

A user should not need to leave the Deck Editor or open a standalone Document Editor in order to edit a Page. Selecting a Page in the thumbnail rail loads that Page's Excalidraw document directly into the central editor. The implementation may reuse the existing document save, attachment, version, recovery, and edit-lease systems internally, but that reuse should remain an implementation detail of the Deck editing experience.

### Page and Document semantics

`Page` and `Document` are distinct concepts even though each Page uses one existing Excalidraw Document as its backing scene storage.

```text
Deck
  -> Page
       -> backing Document
```

Responsibilities are intentionally separated:

- `Deck` owns presentation-level concerns such as Page ordering, aspect ratio, and recording baseline.
- `Page` is the user-facing presentation unit inside a Deck. It owns Deck membership, Page title, ordering, thumbnail presentation, and presentation snapshot relationships.
- `Document` is the lower-level Excalidraw persistence unit. It owns scene storage, attachments, autosave, versions, recovery, and edit lease behavior.

Within Deck workflows, the backing Document is not a separate user-facing object. Users edit and manage the Page; the application routes those edits through the backing Document infrastructure.

### Dashboard visibility

Deck Page backing Documents must not appear as ordinary standalone Documents in the Dashboard.

The Dashboard should expose Decks and standalone Documents as separate user-facing resources:

- A standalone Document appears in the Documents area and is opened directly as a Document.
- A Deck appears in the Decks area and its Pages are managed from the Deck Editor.
- A backing Document owned by a Deck Page is hidden from the standalone Documents list and must not be independently renamed, deleted, or otherwise managed from the Dashboard.

This avoids presenting one stored scene twice under two different user-facing identities.

### Page lifecycle ownership

The Page lifecycle owns the lifecycle of its backing Document. Creating a Page creates its backing Document. Duplicating a Page creates a new backing Document with the duplicated visual state. Deleting a Page must handle its backing Document through the Page deletion flow rather than leaving the user to manage it independently.

For the MVP, deleting a Page permanently deletes its backing Document after the Page is removed from the Deck, and deleting a Deck permanently deletes the backing Documents for all of its Pages. This avoids hidden orphaned Documents in the standalone document system. Recreating a deleted Page from a deleted backing Document is not part of the MVP; recording baseline reset restores Page content for Pages that still exist and does not recreate deleted Page topology.

Conceptual layout:

```text
+--------------------------------------------------+
| Deck title        16:9      Baseline      Present|
+----------+---------------------------------------+
| Page 1   |                                       |
|          |                                       |
| Page 2   |          Excalidraw Editor            |
|          |                                       |
| Page 3   |                                       |
|          |                                       |
|   +      |                                       |
+----------+---------------------------------------+
```

### Required page operations

- create blank page
- duplicate current page
- delete page
- rename page
- reorder pages using thumbnail drag and drop
- previous / next page
- page thumbnail rendering

### Blank page behavior

The `+` button creates a completely new blank page.

### Duplicate behavior

A separate Duplicate action duplicates the current page and inserts the copy immediately after it.

Duplicate:

- Excalidraw elements
- attached image references/content as required by the existing storage model
- current visual state

Do not duplicate:

- old snapshot/version history
- named snapshots
- recording history

The new page begins with its own history.

## Aspect Ratio and Recording Frame

MVP presets:

- 16:9 landscape
- 9:16 portrait

For the MVP, both presets map to fixed scene-space recording-frame bounds with the top-left corner at `(0, 0)`:

- `16:9` -> `1600 x 900` scene units
- `9:16` -> `900 x 1600` scene units

These normalized bounds are presentation metadata rather than Excalidraw elements. Deck Editor may pan and zoom around them, while Present Mode fits exactly these bounds into the recording viewport. Content outside the bounds remains editable during preparation but is outside the normal recorded region.

Custom ratios are out of scope for the MVP.

The Excalidraw editing area may remain larger than the recording target. The Deck should expose a visible recording frame that defines what will be presented.

```text
      editable canvas area

    +--------------------+
    |                    |
    |   recording frame  |
    |       16:9         |
    |                    |
    +--------------------+

      editable canvas area
```

The page content can use the surrounding editing space during preparation, but Present Mode fits the recording frame into the presentation viewport.

### View reset and locked presentation camera

Deck Editor must provide an explicit `Reset View` action that re-fits the shared recording-frame bounds into the preparation viewport. Preparation remains freely pannable and zoomable before and after this action.

Present Mode uses the recording frame as a fixed camera. User zoom and canvas pan gestures are disabled in Present Mode, and each Page transition re-applies the same recording-frame fit. Pen input and application controls remain interactive.

## Present Mode

Present Mode is the most important MVP surface.

### Core rule

> Application controls must not cover the recording frame.

On iPad, the device display is not 16:9, so the unused area around the 16:9 content should be used for presenter controls.

For a 9:16 deck in landscape or other layouts, use the side space for controls where practical.

Example:

```text
+------------------------------------------------+
|                                                |
|    +--------------------------------------+    |
|    |                                      |    |
|    |           RECORDING FRAME            |    |
|    |                                      |    |
|    +--------------------------------------+    |
|                                                |
|   < Prev   3 / 12   Next >   Pen Laser Undo   |
+------------------------------------------------+
```

### MVP controls

Visible, large touch targets:

- Previous
- Next
- current page indicator
- Pen
- Laser
- Undo
- More menu

More menu:

- Reset Current Page
- Hide Controls
- Exit Present Mode

`Reset All Pages` should not be directly exposed in Present Mode because it is too destructive. It belongs in the Deck Editor / after-take flow.

### Touch target size

Controls should be deliberately large for iPad use, approximately 52-60 px targets where layout allows.

### Page transition

MVP uses immediate page switching.

No fade or transition animation.

This is predictable during recording and easier to edit later.

### Save before Present

Entering Present Mode is a durability boundary. The Deck Editor must flush the active Page through the normal attachment and scene-save pipeline and wait for all in-flight edits to persist before navigation. If the save fails, Present Mode must not open.

Creating a Recording Baseline or Named Snapshot from Deck Editor follows the same flush-first rule so checkpoints match the visible Page state.

### Fullscreen presentation

Present Mode should offer browser fullscreen when supported and should also support installation as a standalone web app so iPad-class devices can run the presentation surface without normal browser chrome. Fullscreen failure is non-blocking; it must never prevent the presentation workflow itself.

## iPad Input Behavior

The intended interaction is Apple Pencil or another stylus for drawing, with finger behavior configured separately from stylus behavior. Stylus input is identified through pointer events such as `pointerType === "pen"` where the platform exposes it.

Present Mode exposes one icon-only touch toggle:

- `Touch Off`: finger input on the canvas is fully ignored while stylus input continues to follow the active Present tool.
- `Touch On`: selection interaction takes priority only on an element/selection outline band and nearby selection handles. The interior of a selected bounding box is not treated as a selection hit, so the current Present tool can draw or act inside a selected shape. Outline/handle hits keep move/resize/rotate behavior; otherwise the current Present tool is used.

Stylus input follows the current Present tool on empty space, but touching the active selection bounds or handles with the stylus also prioritizes selection manipulation so resize/move/rotate does not accidentally draw. Touch On does not unlock the fixed Present recording-frame camera.

Before a stylus has ever been detected in the Present session, touch behaves like the current Present tool so touch-only devices can use Pen, Laser, Rectangle, Ellipse, Eraser, and Select naturally. Once `pointerType === "pen"` has been observed, finger input follows the explicit Touch Off/On policy above.

Present Mode should prefer explicit button-driven navigation over gestures to reduce accidental actions during recording.

Target behavior:

```text
Apple Pencil -> draw with Pen or Laser
Touch on canvas -> does not create ink
Touch on controls -> normal UI action
```

Canvas pan/zoom should be locked or strongly restricted in MVP Present Mode so the recording framing cannot be accidentally moved during a take.

The implementation should use pointer events and distinguish stylus input from touch where supported by the embedded Excalidraw behavior.

## Pen and Laser

Present Mode keeps a compact primary tool set in the presenter UI:

### Pen

Creates normal Excalidraw ink and therefore modifies the page.

Annotations remain on the page when moving to another page and remain present if the user returns to that page.

### Laser

Uses Excalidraw's transient laser pointer behavior where possible.

Laser marks should not become permanent page content.

Other Excalidraw tools such as rectangles, arrows, text, image placement, etc. remain available in Deck Editor and do not need to be exposed in the primary Present Mode toolbar for the MVP.

## Recording Baseline Workflow

Before recording, the user selects `Set Recording Baseline`.

This creates a snapshot for every page in the Deck and groups them under a single baseline ID.

Example:

```text
Baseline B1
  Page 1 -> snapshot 91
  Page 2 -> snapshot 42
  Page 3 -> snapshot 17
  Page 4 -> snapshot 38
```

During a take, normal page edits and annotations continue to save normally.

After the take, the user can choose:

### Keep Changes

Do nothing. Current page content remains as edited during recording.

### Destructive-action confirmation

Present Reset/Clear actions should not open a modal confirmation dialog during a take. The same destructive-action button must be tapped twice to confirm: the first tap arms the action and changes the button state, while the second tap executes it. The armed state expires after a short timeout and is cancelled by page navigation or another incompatible action.

### Reset Current Page

Restore only the currently selected page to its snapshot in the active recording baseline.

### Reset All Pages

Restore every page in the Deck that participated in the active recording baseline.

This should be atomic from the user's perspective: either the Deck is restored successfully or failures are clearly surfaced rather than silently leaving an unknown mixed state.

### Pages created after baseline

If a page was created after the active baseline, it has no baseline snapshot.

For MVP, `Reset All Pages` should not delete such pages automatically. Leave them in place and report that they were not part of the baseline.

### Pages deleted after baseline

For MVP, resetting the baseline does not implicitly recreate deleted pages unless implementation reuse makes this safe and trivial. Baseline restore primarily restores page content, not Deck topology.

Deck topology restoration can be considered later.

## Snapshot Behavior

There are three related concepts and they should remain distinct in UX:

### Existing version history

Purpose: recover from normal edits and mistakes.

Retention may be bounded by existing repository rules.

### Named snapshots

Purpose: permanent human-readable checkpoints.

Retention: keep until explicitly deleted.

### Recording baseline

Purpose: quickly reset a Deck after recording annotations.

One active baseline per Deck, with prior baselines preserved as previous checkpoints.

## Deck Edit Session and Lease

Normal Deck editing uses one Deck-scoped edit lease rather than acquiring and releasing a separate Document lease for each Page. A live Deck lease protects every backing Document in that Deck from concurrent editing by another browsing context, including another tab owned by the same user.

Deck Editor and Present Mode are two surfaces within the same logical Deck editing session. Moving between them retains the Deck lease through session-scoped credentials and idempotent reacquisition. The lease is released when the browsing context leaves the Deck workflow, with TTL expiry as the fallback.

Standalone Documents continue to use Document-scoped edit leases. A Deck Page backing Document may be saved under its owning Deck's valid lease, but that lease cannot authorize any standalone Document or another Deck's Page. Baseline and reset operations use the same Deck lease as their concurrency boundary and do not require the current holder to release its own lease first.

Detailed concurrency and transition behavior is defined in `docs/superpowers/specs/2026-09-01-deck-presentation-session-design.md`.

## Present Mode State

Present Mode does not create a separate temporary annotation layer in MVP.

Normal Pen annotations are real page edits and persist while navigating between pages.

This keeps the architecture simple and makes the baseline mechanism the single recovery model:

```text
Page 1 -> annotate
Page 2 -> annotate
Page 1 -> annotations are still there
Exit -> Reset All -> all baseline pages return to pre-recording state
```

A separate temporary ink layer may be considered after the MVP is proven useful.

## MVP Feature List

1. Deck create, rename, delete
2. 16:9 and 9:16 Deck aspect ratio
3. blank Page creation
4. Page duplication
5. Page deletion
6. Page reorder using thumbnails
7. Page thumbnails
8. previous / next Page navigation
9. Present Mode
10. Pen and Laser in Present Mode
11. Named permanent snapshots
12. Recording baseline
13. Reset Current Page
14. Reset All Pages
15. iPad-friendly Pencil-vs-touch behavior
16. controls outside the recording frame
17. Reset View in Deck Editor and locked Present viewport
18. save-before-Present transition gate
19. Deck-scoped edit lease across Deck Editor and Present Mode
20. fullscreen and installed standalone web-app presentation support

## Explicit Non-Goals for MVP

Do not build these as part of the first implementation unless they become necessary for the core workflow:

- built-in screen/video recording
- OBS integration
- audio capture
- video export
- timeline editing
- slide transition animations
- presenter notes
- second-screen presenter view
- temporary ink layer
- spotlight tool
- remote controller
- slide templates
- safe-area overlays for TikTok / YouTube Shorts / Reels
- custom aspect ratio
- page-specific transitions
- object animation
- automatic presentation generation

Existing iPad/macOS screen recording or OBS can handle capture. The application only needs to provide a clean, predictable presentation surface.

## UX Principles

### Recording content always wins

No toolbar, popover, navigation control, or status UI should cover the recording frame during normal presentation.

### Explicit actions over gestures

Use obvious, icon-first buttons for Previous, Next, Select, Pen, Rectangle, Ellipse, Eraser, Laser, Undo, Reset, fullscreen, hide/show controls, and exit. The pinned Excalidraw imperative API does not expose a stable public Redo action, so Present Mode does not expose Redo. Every icon button keeps an accessible label and tooltip. Gestures should not be required for MVP operation.

### Safe destructive actions

- Reset Current can live in the Present Mode More menu.
- Reset All belongs outside the main Present controls.
- Do not silently delete pages created after the baseline.

### Fast retakes

The product should make this sequence trivial:

```text
Take 1
-> annotations everywhere
-> not happy with recording
-> Reset All Pages
-> Take 2
```

## MVP Success Criteria

The MVP is successful when a user can complete this scenario reliably on an iPad:

1. Create a 10-page 16:9 Deck.
2. Place images and simple Excalidraw content on each page.
3. Save a Recording Baseline.
4. Enter Present Mode without application UI covering the 16:9 recording frame.
5. Navigate all pages using large visible buttons.
6. Use Apple Pencil to annotate pages while touch does not accidentally draw on the canvas.
7. Use Laser for transient emphasis.
8. Return to previously visited pages and see their annotations preserved.
9. Exit Present Mode.
10. Reset all baseline pages with one explicit action.
11. Confirm all 10 baseline page contents match the pre-recording state.
12. Immediately begin another take.

## Follow-up Features After MVP

Candidates after real recording usage validates the workflow:

- temporary presentation ink
- left / bottom / right control placement preference
- handedness presets
- presenter notes
- clean mode with fully hidden controls
- Shorts/Reels safe-area overlays
- spotlight mode
- custom ratios
- keyboard shortcuts
- remote presentation controls
- optional transitions
- multi-device presenter view

## Implementation Bias

Prefer extending and composing existing repository concepts rather than replacing them.

In particular, reuse existing:

- Excalidraw document persistence
- attachment storage
- thumbnails
- version snapshots / restore primitives
- autosave pipeline
- edit lease behavior

The new feature should primarily introduce Deck/Page orchestration and presentation-specific state around those existing systems.

### Present color behavior

The color palette changes the future stroke color for Pen, Rectangle, and Ellipse without forcing a tool switch. If one or more elements are selected, the same palette action also updates every selected element's stroke color immediately and records the change as an undoable local scene update. Laser color remains independent.

### Present Laser modes and global settings

Present Laser is rendered by a scene-neutral overlay rather than Excalidraw's native Laser so the presentation pointer can be fully customized without creating scene elements or dirtying autosave. The user has two globally persisted modes: `Trail` and `Dot`. Re-tapping the active Laser button in Present toggles only between these modes and persists the last mode for the current user. Present never exposes Laser settings controls.

Laser customization lives outside Present in Deck Edit and is global to the authenticated user rather than deck-specific. Trail settings include color, core size, glow size, point length, and decay time. Dot settings include color, size, and glow size. Server-side normalization bounds all numeric values and validates colors before persistence.
## Aspect-aware Deck Edit chrome

Deck Edit chrome follows the Deck aspect ratio, not the browser viewport. For `9:16`, the editor uses a compact top header, a left Page/navigation rail, a right utilities/snapshots rail, no persistent bottom chrome, and an embedded Excalidraw toolbar laid out vertically without rotating the toolbar DOM. For `16:9`, Pages remain in the left rail, the embedded Excalidraw toolbar remains horizontal, and Page navigation plus snapshot access share one compact bottom bar. Standalone document editing retains its normal Excalidraw layout.

## Recording frame fit in Deck Edit

On initial Deck Page editor load and on Reset View, the recording area is fit with `fitToViewport` at full viewport factor so the complete recording box is as large as possible without being cropped. Deck Edit does not impose the Present camera's `maxZoom: 1` cap. Present Mode keeps its existing fixed camera fit and zoom cap.
