# Video Presentation MVP TODO

This file tracks implementation gaps against `design.md`. The design document remains the product source of truth.

## Next: Deck editing UX alignment

- [x] Replace the temporary `Edit page` navigation with inline Excalidraw editing in the Deck Editor. Selecting a Page should make the central Deck Editor surface immediately editable.
- [x] Reuse the existing Document save, attachment, autosave, version, recovery, and edit-lease pipelines from the inline Deck Editor rather than creating a second persistence system.
- [x] Hide Documents that are backing storage for Deck Pages from the standalone Dashboard Documents list.
- [x] Ensure Page rename/delete/lifecycle actions remain user-facing Page operations and cannot be independently managed through the backing Document in normal UI.
- [x] Define and implement cleanup/soft-delete behavior for a backing Document when its Page is deleted, using existing recovery primitives where appropriate.

## Recording frame alignment

- [x] Show the Deck aspect-ratio recording frame in the inline Deck Editor.
- [x] Make Present Mode use the same recording-frame scene bounds so preparation framing and recorded output match exactly.
- [x] Keep the surrounding Excalidraw canvas usable during preparation while only the recording-frame region is fitted into Present Mode.

## Presentation session hardening

- [x] Add a Deck-scoped edit lease that covers every Page backing Document and persists across Deck Editor and Present Mode within the same browsing context.
- [x] Flush the active Page successfully before entering Present Mode, and keep Present navigation blocked on save failure.
- [x] Add Deck Editor `Reset View` and prevent user zoom/pan from changing the fixed recording-frame camera in Present Mode.
- [x] Add browser fullscreen controls and standalone web-app metadata for browser-chrome-free presentation where the platform supports it.

## Present input and control refinement

- [x] Verify whether Redo can be supported through a stable Excalidraw public action path. No stable public Redo action is exposed by the pinned Excalidraw API, so remove the Redo control and related wiring.
- [x] Convert the primary Present controls to icon-first buttons while retaining accessible labels/tooltips. This includes Select, Pen, Eraser, Laser, Undo, Previous, Next, Reset, fullscreen, hide/show controls, and exit.
- [x] Detect stylus input through `pointerType === "pen"` and keep stylus behavior independent from touch behavior.
- [x] Replace Present touch configuration with one icon-only On/Off toggle. Off fully ignores finger input on the canvas; On prioritizes selection interaction and falls back to the active Present tool on empty space.
- [x] Preserve selection manipulation under Touch On: existing elements and active selection bounds/handles use Select behavior, while Pen also yields to active selection bounds/handles before drawing. Keep the fixed recording-frame camera.
- [x] Replace destructive Reset/Clear confirmation popups with same-button double-tap confirmation, including timeout/cancellation behavior and regression coverage for the new Present input/control states.

- [x] Before any stylus is detected, let touch act as the current Present tool so touch-only devices can use Pen, Laser, Rectangle, Ellipse, Eraser, and Select; after `pointerType === "pen"` is detected, use the explicit Touch Off/On policy.
- [x] Add icon-first Rectangle and Ellipse tools to Present Mode and preserve the selected shape tool across page navigation.
- [x] Make the Present color palette update the future stroke color without switching tools, and apply the chosen stroke color immediately to all selected elements when a selection exists.

- [x] Add user-global Present Laser preferences with persisted Trail/Dot mode and customizable colors, sizes, glow, trail length, and decay.
- [x] Add Laser settings UI outside Present Mode in Deck Edit; Present itself must expose no Laser settings UI.
- [x] Replace native Present Laser rendering with a scene-neutral overlay supporting customizable Trail and trail-free Dot modes.
- [x] Make re-tapping the active Laser button toggle Trail/Dot and persist the last mode globally for the current user.
- [x] Add regression coverage for Laser preference persistence, edit-only settings UI, mode toggling, and overlay rendering contracts.

## MVP validation

- [x] Run the complete 10-page 16:9 recording workflow on iPad-class pointer input.
- [x] Verify Apple Pencil draws while touch does not create ink.
- [x] Verify Pen annotations persist across Page navigation.
- [x] Verify Laser remains transient.
- [x] Verify Reset All restores baseline-participating Pages while retaining Pages created after the baseline.

- [x] Derive Deck Edit chrome orientation from Deck aspect ratio only: `9:16` portrait side-rail mode and `16:9` landscape top/bottom mode.
- [x] Support embedded Excalidraw toolbar orientation so `9:16` uses a true vertical tool rail and `16:9` keeps a horizontal toolbar without CSS rotation.
- [x] Recompose `9:16` Deck Edit chrome with compact top header, left page/navigation rail, right utilities/snapshots rail, and no persistent bottom chrome.
- [x] Recompose `16:9` Deck Edit chrome with compact header and one bottom row combining page navigation and snapshot access.
