# Deck Presentation Session Design

## Goal

Make Deck editing and Present Mode behave as one reliable presentation session: the Deck owns the edit lease, pending edits are durably saved before presentation begins, preparation view can be reset to the recording frame, Present Mode cannot be zoomed or panned, and the presentation surface can run without browser chrome through fullscreen or an installed web app.

## Scope

This design adds four MVP behaviors:

1. Deck-scoped edit lease for all Page backing Documents in one Deck.
2. Save-before-Present as a hard transition gate.
3. Reset View in Deck Editor and locked viewport behavior in Present Mode.
4. Browser fullscreen plus installable standalone web-app presentation support.

The existing standalone Document editor continues to use the existing Document edit lease model.

## Session Boundary

A Deck editing session begins when an editable Deck Editor acquires the Deck lease and ends when that browsing context leaves the Deck workflow.

Deck Editor and Present Mode are two surfaces inside the same logical session:

```text
Deck Editor
  -> save flush
  -> Present Mode
  -> Deck Editor
```

Moving between these two surfaces must not intentionally release the Deck lease. Lease credentials are scoped to the Deck and browsing context, stored in session-scoped browser storage, and reused for an idempotent reacquire when the route changes.

Closing the tab, navigating to an unrelated route, or otherwise leaving the Deck workflow triggers best-effort release. If release cannot complete, TTL expiry remains the safety net.

## Deck Edit Lease

### Ownership

A Deck has at most one active editing session at a time.

The active Deck lease blocks every Page backing Document in that Deck from being edited by another browsing context, including another tab owned by the same user. This matches the presentation mental model: a Deck is one editing and recording unit, not a collection of independently concurrent Pages.

### Persistence model

Introduce a Deck-specific lease record rather than overloading `document_edit_leases`.

Conceptually:

```ts
type DeckEditLease = {
  deckId: string;
  holderUserId: string;
  holderClientId: string;
  leaseToken: string;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  takeover?: {
    requestId: string;
    userId: string;
    clientId: string;
    leaseToken: string;
    requestedAt: string;
    deadlineAt: string;
  };
};
```

The Deck lease uses the same TTL, fencing generation, same-context re-entry proof, takeover timeout, holder summary, and heartbeat principles as the existing Document lease unless a Deck-specific requirement says otherwise.

### Save authorization

Standalone Document saves continue to require valid Document lease credentials.

A Page backing Document may instead be saved using valid Deck lease credentials for the Deck that owns the Page. Server-side authorization must verify all of the following before accepting the save:

- the Document is the backing Document of a Page in the claimed Deck
- the requester has write access to the Deck
- the Deck lease credentials are current and not expired
- the lease generation matches the current Deck lease generation

A Deck lease must never authorize writes to a standalone Document or to a Page in another Deck.

### Baseline and reset

Baseline and reset operations are Deck-level mutations and therefore use the Deck lease as their concurrency boundary.

The current holder of the Deck lease may create a baseline, reset the current Page, or reset all participating Pages without first releasing its own lease.

If another live Deck session owns the Deck lease, these operations are blocked. The old rule that a Page reset must fail merely because its own backing Document has an active Document lease remains relevant only to standalone or legacy access paths; normal Deck workflows must not create per-Page Document leases.

## Save-Before-Present Gate

Entering Present Mode is a durability boundary.

When the user presses Present:

1. Stop or supersede the current debounce timer.
2. Flush the active Page scene through the normal save and attachment pipeline.
3. Wait until any in-flight save and any edits made during that save are fully persisted.
4. If saving fails, remain in Deck Editor and surface the error. Do not navigate to Present Mode.
5. If saving succeeds, retain the Deck lease and enter Present Mode.

The same flush-first rule applies before creating a Recording Baseline or Named Snapshot from Deck Editor so checkpoints never capture a state older than what the user currently sees.

Present Mode continues to save Pen annotations before Page navigation and before exiting Present Mode.

## Viewport Policy

### Deck Editor

Deck Editor remains a normal Excalidraw preparation workspace. Pan and zoom are allowed, including work outside the recording frame.

Add an explicit `Reset View` action. It fits the Deck's fixed recording-frame bounds into the editor viewport using the preparation-view margin. It does not modify scene content or persist viewport state as presentation content.

Changing Pages may initialize the editor to the recording frame, but the user remains free to pan and zoom afterward.

### Present Mode

Present Mode is a fixed camera over the recording frame.

The Deck aspect-ratio bounds are fitted to the presentation viewport when the Page opens. After that, user viewport manipulation is disabled:

- mouse wheel zoom is blocked
- trackpad pinch/zoom is blocked
- touch pinch zoom is blocked
- touch canvas panning is blocked
- Excalidraw viewport gestures must not move the camera

Stylus input identified as `pointerType === "pen"` remains independent from finger enablement and follows the active Present tool on empty space. Before the first stylus detection, touch on empty space follows the current Present tool so a touch-only device remains fully usable. Laser continues to use Excalidraw's transient laser tool. Present exposes one icon-only touch toggle: Off ignores finger input on the canvas; On prioritizes selection interactions only on an element/selection outline band and nearby selection handles, while the interior of a selected bounding box falls back to the current Present tool. Stylus input also prioritizes the active selection bounds/handles so resize/move/rotate does not become drawing. Touch behavior must not unlock or move the fixed recording-frame camera, and touch on application controls remains functional.

Changing Pages re-applies the same fixed frame fit so every Page uses the same camera geometry.

## Fullscreen and Installed App Behavior

The recording surface should be usable without browser chrome where the platform permits it.

### Regular browser

Present Mode exposes an explicit fullscreen action backed by the browser Fullscreen API when supported. The action must be initiated from a user gesture. Failure or unsupported environments must not prevent Present Mode from functioning.

The application must not rely on automatically entering fullscreen after navigation because browser gesture rules make that unreliable.

### Installed web app

Add a web-app manifest and application metadata so the workspace can be launched from the home screen in standalone presentation-oriented display mode.

The installed-app path is the preferred browser-chrome-free experience on iPad-class devices where normal page fullscreen APIs are limited. Presentation behavior itself remains identical whether the app runs in Safari, another browser, or installed standalone mode.

Offline editing is not part of this change. A service worker is not required merely to change the presentation session model; if an installation target requires additional installability plumbing, it should be kept minimal and must not introduce offline persistence semantics.

## UI Behavior

Deck Editor gains `Reset View` next to other Page preparation controls.

The existing Present action becomes an async transition control:

```text
Present
  -> Saving...
  -> enter Present Mode only after success
```

Present Mode gains a fullscreen control in presenter UI, not over the recording frame. If already fullscreen or running in an installed standalone display, the control may be hidden or change to an exit-fullscreen action.

Present Mode does not expose zoom controls.

Primary Present controls are icon-first with accessible labels/tooltips. The pinned Excalidraw imperative API does not expose a stable public Redo action, so Redo is not exposed in Present Mode. Destructive Reset/Clear actions use same-button double-tap confirmation instead of modal confirmation, with a short expiry and cancellation on page navigation or incompatible actions.

## Failure Handling

- Deck lease unavailable: Deck opens read-only or blocked with the existing takeover-style resolution UI adapted to Deck scope.
- Lease lost while editing or presenting: stop accepting saves, surface a blocking state, and do not silently continue as if edits are protected.
- Save before Present fails: stay in Deck Editor.
- Save before Page navigation in Present fails: stay on the current Page.
- Fullscreen request fails: remain in Present Mode without fullscreen and surface only a non-blocking status if useful.
- Best-effort release fails: rely on TTL expiry, as with the current Document lease system.

## Compatibility

Standalone Documents retain their current behavior and APIs unless a shared lease utility is refactored internally.

Deck Page backing Documents remain hidden from the standalone Dashboard list. Normal Deck UI must stop acquiring per-Page Document leases once Deck lease support is active.

Existing saved Decks require no content migration beyond creation of the new Deck lease table because lease state is ephemeral concurrency metadata.

## Testing

Automated coverage must include:

- only one active Deck lease per Deck
- same-context Deck route re-entry is idempotent and preserves fencing semantics
- another tab, including the same user, is blocked while the Deck lease is live
- Deck lease cannot save an unrelated Document or another Deck's Page
- Page saves under a valid Deck lease succeed without a Document lease
- reset and baseline operations owned by the active Deck session succeed without releasing the Deck lease
- Present navigation is cancelled when the pre-navigation save fails
- Deck Editor to Present navigation is cancelled when the flush fails
- Reset View targets the exact shared recording-frame bounds
- Present Mode source and model enforce fixed viewport behavior
- fullscreen capability is optional and failure is non-blocking
- manifest metadata declares standalone presentation-capable display behavior

Manual iPad validation remains required for Apple Pencil versus touch behavior and the complete installed-app/fullscreen recording workflow.


Rectangle and Ellipse are also available as persistent Present drawing tools. Present palette changes update the current item stroke color and, when elements are selected, update the selected elements' stroke colors in the same undoable scene action without changing the active tool.


Present Laser uses a custom scene-neutral overlay with two user-global modes, Trail and Dot. The active mode and visual parameters are stored per authenticated user. Trail exposes color, core size, glow size, trail length, and decay duration; Dot exposes color, size, and glow size. Configuration is available outside Present Mode only. Inside Present, the first Laser tap activates Laser and a re-tap toggles Trail/Dot while persisting the chosen mode.
