# Local Draft Recovery Conflict Design

**Date:** 2026-08-31  
**Status:** Implemented — automated verification complete; browser manual/E2E verification pending (declined by user)
**Scope:** Load-time conflict resolution between an authenticated user's browser draft and the current server scene

## 1. Goal

When an editable document has different client and server content at load time, require the user to choose which version to use. By default, preserve the version that will not be selected as a recovery snapshot before applying the choice.

The flow must not silently discard either version, must not rely on browser/server clock ordering, and must never expose one account's draft to another account.

## 2. Scope

Included:

- Conflict detection when opening or refreshing a document.
- Required conflict-resolution UI for `OWNER`, `EDITOR`, and admin write access.
- Optional preservation of the unselected version as a snapshot; enabled by default.
- Immediate server persistence when the client draft is selected.
- User-scoped local draft storage.
- Existing crash-recovery edge cases identified in the 2026-08-31 audit.

Excluded:

- Real-time multi-user editing or conflict prompts while the editor is already open.
- Side-by-side canvas previews or visual diffs.
- A `VIEWER` action for deleting, restoring, or previewing a client draft.
- A dedicated legacy-draft migration UI.

## 3. Roles and permissions

### Writable access

`OWNER`, `EDITOR`, and an administrator with effective write access use the full conflict flow.

### Viewer or deleted document

A `VIEWER`, or a user viewing a document that is not currently writable, always sees the server scene in read-only mode.

- Do not inspect the user's local draft for mismatch handling.
- Do not display a conflict prompt.
- Do not create a snapshot.
- Do not update or delete local draft data.

If write access is granted later, the preserved user-scoped draft participates in normal conflict detection the next time the document is loaded.

## 4. Draft storage contract

New drafts use a user- and document-scoped key:

```text
excalidraw_draft_<userId>_<docId>
```

The stored value remains compact for persisted attachments and keeps inline `dataURL` only for files that have not reached the server:

```typescript
interface LocalDraftEnvelope {
  scene: ExcalidrawScene;
  updatedAt: number; // browser time; display-only
}
```

The previous `excalidraw_draft_<docId>` key has no trustworthy account identity. It remains untouched but is excluded from automatic recovery so it cannot be attributed to the wrong user.

Malformed values are not automatically removed. The editor loads the server scene and displays a recovery warning. Browser time is informational only and never decides which version wins.

## 5. Conflict detection

Conflict detection runs before mounting the editable canvas so Excalidraw cannot emit an initial `onChange` and create a third state while the decision is pending.

Comparison uses the existing compact scene comparison rules:

- Compare elements in scene order.
- Compare active image metadata, with file IDs ordered deterministically.
- Compare `viewBackgroundColor`.
- Ignore in-memory attachment `dataURL` values added by hydration.
- Treat an empty `elements` array as valid content.
- Ignore `updatedAt` when determining equality.

Outcomes:

| Condition | Result |
|---|---|
| No draft | Mount the server scene. |
| Draft equals server after normalization | Remove the scoped draft and mount the server scene. |
| Draft differs from server | Keep the canvas unmounted and show the required conflict dialog. |
| Draft is malformed | Preserve the raw value, mount the server scene, and show a warning. |
| User cannot write | Mount the server scene without reading or changing the draft. |

## 6. Conflict dialog

The modal cannot be dismissed with `Escape`, a close button, or a backdrop click. The canvas remains unavailable until one choice completes successfully.

Display for each version:

- Label: `Client draft` or `Server version`.
- Last-updated time for context only.
- Total element count.
- Active image count.

Controls:

- Selectable cards for `Client draft` and `Server version` (`aria-pressed` on native buttons, Enter/Space activation, selected `border-blue-600`/`bg-blue-50`/`ring`/`✓` and hover `border-gray-300`/`bg-gray-50`, no initial selection)
- Single `Confirm selection` button disabled until a card is selected or while busy; confirms the selected choice exactly once
- Checked by default: `Preserve the version not selected as a recovery snapshot`

No canvas thumbnail or scene preview is included.

## 7. Resolution behavior

### Use client draft

1. Upload any active client attachments that are not yet persisted.
2. Send the compact client scene, the server version token, and the preservation preference to the recovery endpoint.
3. If preservation is enabled, snapshot the current server scene.
4. Replace the current server scene with the client scene.
5. After the endpoint succeeds, mount the selected client scene and remove the scoped local draft.

The client scene is persisted immediately. It does not wait for Excalidraw `onChange` or the normal three-second auto-save debounce.

### Use server version

1. If preservation is enabled, upload any active client attachments that are not yet persisted.
2. Send the compact client scene, the server version token, and the preservation preference to the recovery endpoint.
3. If preservation is enabled, snapshot the client scene without replacing the current document.
4. Keep the current server scene.
5. After the endpoint succeeds, mount the server scene and remove the scoped local draft.

If preservation is disabled, selecting the server does not upload discarded client attachments or create a snapshot.

### Snapshot retention

Recovery snapshots use the existing per-document retention limit of the newest 20 snapshots. Creating a conflict snapshot may prune the oldest snapshot under the existing policy.

The scene snapshot is required. Thumbnail creation remains best-effort and a missing thumbnail does not invalidate an otherwise successful snapshot.

## 8. Server API

Add one write-authorized endpoint:

```text
POST /api/documents/<docId>/recovery
```

Request:

```typescript
interface ResolveRecoveryConflictRequest {
  choice: "client" | "server";
  preserveDiscarded: boolean;
  expectedServerUpdatedAt: string;
  clientScene: ExcalidrawScene;
  clientUpdatedAt: number;
  clientThumbnailBase64?: string;
}
```

Success response:

```typescript
interface ResolveRecoveryConflictResponse {
  ok: true;
  choice: "client" | "server";
  snapshotCreated: boolean;
  updatedAt: string;
}
```

Conflict response (`409`):

```typescript
interface RecoveryConflictChangedResponse {
  ok: false;
  code: "SERVER_VERSION_CHANGED";
  serverScene: ExcalidrawScene;
  serverUpdatedAt: string;
}
```

The route must:

1. Authenticate the request and require current write permission.
2. Validate the request fields and compact client scene.
3. Compare `expectedServerUpdatedAt` with the current document `updated_at` value.
4. Return HTTP `409` with the latest compact server scene and no mutation if the server version changed.
5. Execute the required snapshot insert and document scene update in one database transaction.
6. Reuse existing attachment validation, snapshot retention, and garbage-collection rules.

For `choice: "server"` with `preserveDiscarded: false`, the endpoint validates permission and the server version token but performs no scene or snapshot mutation.

## 9. Concurrency and attachment ordering

`expectedServerUpdatedAt` is an optimistic concurrency token, not a freshness heuristic. A `409` response keeps the local draft and dialog open, replaces the dialog's server metadata with the latest server state, and requires a new explicit choice.

Attachment upload occurs before the recovery transaction because binaries use the existing multipart endpoint. If a later conflict resolution fails, the uploaded but unreferenced attachment remains eligible for the existing 24-hour storage-maintenance cleanup.

When the client scene will be saved or snapshotted, the recovery endpoint rejects any active attachment missing from server storage. For `choice: "server"` with preservation disabled, the client scene is discarded, so attachment existence is not validated and no client attachment is uploaded.

## 10. Failure behavior

Attachment upload, snapshot creation, authorization, concurrency validation, and scene persistence are all fail-closed:

- Keep the modal open.
- Keep the scoped local draft unchanged.
- Do not mount an editable canvas with an unresolved scene.
- Show the specific failure in the modal and allow retry.

The local draft is removed only after the complete selected flow succeeds.

If localStorage quota prevents writing a new draft during editing, surface a visible save warning instead of silently ignoring the failure.

## 11. Existing edge-case corrections

- Returning to the last server-saved content deletes any scoped draft and cancels its pending debounce.
- An empty scene is recoverable and participates in conflict detection.
- Restoring a client draft explicitly persists it; it does not depend on canvas initialization callbacks.
- Hydration-only `dataURL` changes do not create conflicts or dirty state.
- User-scoped keys prevent draft reuse after account switching on the same browser.

## 12. Verification criteria

Automated coverage must prove:

1. Equal normalized scenes remove the scoped draft without a prompt.
2. Any normalized content difference prompts regardless of timestamps.
3. Empty client scenes can be selected and persisted.
4. Edit followed by undo to the server state removes the stale draft and cancels auto-save.
5. Choosing client with preservation snapshots the prior server scene before replacement.
6. Choosing server with preservation snapshots the client scene while leaving the document unchanged.
7. Disabling preservation creates no conflict snapshot.
8. Snapshot or save failure retains both the dialog and local draft.
9. A changed `updated_at` returns `409` with no snapshot or scene mutation.
10. New client images are uploaded before a client scene is saved or snapshotted.
11. `VIEWER` loads only the server scene and does not read, modify, or delete draft storage.
12. Draft keys isolate two users opening the same document in one browser profile.
13. Malformed and legacy drafts are not silently deleted or automatically attributed.
14. Snapshot retention remains capped at 20 and attachment GC retains files referenced by surviving snapshots.

Manual browser verification must cover refresh with both choices, the default checkbox and unchecked path, retry after a forced API failure, and image recovery without `/documents/undefined` requests.
