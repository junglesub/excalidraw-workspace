# Deck Editor Aspect-Aware Chrome Design

## Goal
Rearrange Deck Edit chrome based on the Deck aspect ratio so the long dimension of the recording frame keeps maximum usable canvas space while controls move into the naturally unused axis.

## Orientation rule
- The layout is determined by `deck.aspectRatio`, not the browser viewport.
- `9:16` uses portrait editor chrome.
- `16:9` uses landscape editor chrome.
- Resizing the browser alone must not flip the Deck chrome orientation.

## Portrait 9:16
- Keep the global header minimal: Dashboard, Deck title, aspect ratio, Present/status essentials only.
- Remove persistent bottom chrome.
- Keep page thumbnails and page navigation in a left rail. Previous, page count, and Next live in this rail.
- Move Deck utilities and Named Snapshots into a right-side utility rail. Snapshots are collapsed behind a compact trigger rather than consuming permanent height.
- Render the embedded Excalidraw tool controls vertically in the right-side editing area, without rotating the existing horizontal toolbar DOM. Popovers/tooltips must retain normal orientation.
- Preserve the recording-frame camera behavior and existing save/lease semantics.

## Landscape 16:9
- Keep page thumbnails in the left rail.
- Render Excalidraw tools horizontally above the canvas.
- Merge page navigation and Named Snapshots into one compact bottom bar instead of separate snapshot and navigation rows.
- Keep the global header smaller than today and avoid wrapping into multiple rows under normal desktop widths.

## Named Snapshots
- Portrait: compact side-rail trigger opens the snapshot actions/list.
- Landscape: compact trigger/list shares one bottom bar with Previous / page count / Next.
- Snapshot create/delete behavior remains unchanged.

## Excalidraw toolbar integration
- Add an embedded editor chrome/orientation contract passed from Deck Editor -> EmbeddedPageEditor -> EditorClient/ExcalidrawCanvas.
- Do not use CSS rotation to fake a vertical toolbar.
- The embedded toolbar must have explicit `horizontal` and `vertical` layouts so color pickers, dropdowns, and tooltips render correctly.
- Standalone document editing keeps its existing layout.

## Non-goals
- No change to Present Mode layout.
- No change to Deck aspect ratio semantics or recording frame dimensions.
- No change to page ordering, snapshots API, edit leases, autosave, or Laser settings persistence.
- No viewport-driven automatic orientation switching.

## Validation
- Source/behavior tests cover the aspect-ratio mapping and chrome placement contracts.
- Existing Deck editor and presentation tests remain green.
- Full typecheck and production build must pass.
- Verify both `/decks/[id]` aspect modes keep the canvas usable and do not expose duplicate Excalidraw chrome.
