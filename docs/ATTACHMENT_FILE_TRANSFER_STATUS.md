# Direct Binary Attachment Transfer — Status

**Date:** 2026-08-27  
**Scope:** compact scene wire format, disk attachments, client hydration, save pipeline, thumbnails  
**Editor:** `@excalidraw/excalidraw` 0.18.1 (latest stable npm; not git `master` / `@next`)  
**Verdict: GO for the code path** (browser E2E still outstanding)

Scene JSON no longer carries image Base64. Files are stored under `data/attachments/<docId>/<fileId>`. The browser fetches binaries and builds in-memory `data:` URLs because Excalidraw `addFiles` / `img.src` require that. This is transport and storage optimization, not URL rendering.

---

## 1. Current behavior

| Surface | Behavior |
|---|---|
| Document / share JSON | Compact `files`: `{ id, mimeType, created }` only |
| Editor load | Fetch `/api/attachments/<fileId>?docId=…` (optional `token` on share links), then `addFiles` |
| New images | Multipart upload, then compact scene save. Max **25 MB** |
| localStorage draft | Compact metadata for persisted fileIds; `dataURL` only for not-yet-uploaded files |
| Unload | `beforeunload` keepalive PUT of a compact scene |
| Export `.excalidraw` | Server hydrates Base64 into a portable file |
| Dashboard thumbnail | Client `exportToBlob` PNG on manual save / snapshot. Document path is always `thumbnails/<docId>.png` |
| Version history | Badge after `Version N`: Manual save / Auto snapshot / Restore / Client draft / Server version / Legacy / unknown (nullable `document_versions.origin`) |

Do not pass compact files (missing `dataURL`) into Excalidraw `initialData`. `addFiles()` will not replace an existing file id, and `img.src = undefined` becomes `/documents/undefined`.

---

## 2. Done (must-fix and should-fix from the review)

| ID | Item | Status |
|---|---|---|
| M1 | Compact files omitted from `initialData`; hydrate then `addFiles`; Strict Mode retry | Done |
| M2 | Steady-state save rejects live image `fileId`s missing from DB or disk (400) | Done |
| M3 | `documents.thumbnail_path` is `thumbnails/<docId>.png`; version GC must not delete it | Done |
| M4 | Attachment upload cap 25 MB → 413 | Done |
| M5 | Editor snapshots compact with `allowInlineDataUrl: false` (import/migration still allow inline) | Done |
| S2 | `GET /api/documents/[id]/attachments` uses `requireRead` | Done |
| S3 | Compact `beforeunload` keepalive | Done |
| S4 | Non-blocking “n image(s) failed to load” notice | Done |
| Restore thumbs | `insertSnapshot` does not overwrite the document PNG with the stripe placeholder when no client buffer is provided | Done |

---

## 3. Still open

| ID | Item |
|---|---|
| M6 | Browser E2E: insert image → save → hard reload → `GET /api/attachments/…?docId=` 200, no `/documents/undefined` |
| S1 | Thumbnail capture can miss images if save runs before the first hydrated `onChange`; auto-save does not refresh the dashboard preview |
| S5 | Attachment `Cache-Control: immutable` is valid only while `(docId, fileId)` content cannot change (409 on mismatch) |
| S6 | Attachment GET with `?docId=` returns 404 if missing, 403 if present but forbidden |

`allowInlineDataUrl: true` remains only for `.excalidraw` import and `migrateLegacyScenes()`.

---

## 4. Not bugs

- Network “Img” entries that look like Base64 after a successful `/api/attachments` fetch: Excalidraw always paints from in-memory `data:` URLs.
- Tab-to-cycle flowchart node type: not in 0.18.1. `Ctrl`/`Cmd`+arrow flowchart nodes are in 0.18.0+.
- `renderScenePng` is a stripe placeholder used when no client PNG is available, not a scene rasterizer.

---

## 5. localStorage crash-recovery audit (2026-08-31)

### Current flow

1. An actual scene change writes `excalidraw_draft_<docId>` immediately as `{ scene, updatedAt: Date.now() }`.
2. Persisted image records are compact metadata; only not-yet-uploaded images retain `dataURL` in the draft.
3. A 3-second debounced save uploads new attachments, then writes a compact scene to the server.
4. A completed save removes the draft only when the in-memory scene still matches the scene that was saved. In-flight edits retain the draft and trigger another save loop.
5. `beforeunload` makes a best-effort `keepalive` PUT of the dirty compact scene. The local draft remains the fallback for a failed unload request and for unuploaded image data.
6. On reload, the client compares the draft's client timestamp with `documents.updated_at`; a strictly newer, non-empty, content-different draft replaces the initial server scene.

### Findings

| Severity | Finding | Evidence / impact |
|---|---|---|
| High | Edit → undo back to the last server state leaves the older draft behind | `handleChange` sets `isDirtyRef` false and returns without deleting the existing key or cancelling the pending timer. The timer later exits because the scene is clean, so reload can resurrect the undone edit. |
| High | A newer empty-scene draft is never restored | The restore gate requires `draftScene.elements.length > 0`. Deleting every element and refreshing before server save reloads the older non-empty server scene. |
| High | Draft keys are not user-scoped | The key contains only `docId`, and logout does not clear drafts. On a shared browser, another authorized account opening the same document can see or save the previous account's unsaved draft. |
| Medium | Timestamp ordering compares different clocks | Draft time comes from the browser and server time comes from the host. Clock skew can discard a valid draft or make a stale draft win. |
| Medium | Restored drafts are not explicitly marked dirty or queued for save | The restore effect replaces the canvas scene but relies on Excalidraw's subsequent `onChange` callback to mark it dirty and start the debounce. There is no component-level regression test for this behavior. |
| Low | Invalid and legacy drafts can remain indefinitely | JSON parse errors are ignored without removing the key. A legacy scene-only draft has timestamp `0`; when a server timestamp exists it is neither restored nor cleared. |

Existing tests cover compact image metadata, in-flight save comparison, and hydration-only comparison. They do not exercise the mount-time localStorage restore effect or the edge cases above.

The approved replacement behavior is specified in [Local Draft Recovery Conflict Design](superpowers/specs/2026-08-31-local-draft-recovery-conflict-design.md).

### Resolved findings (2026-08-31 local draft recovery)

| Finding | Implemented correction | Test file |
|---|---|---|
| Edit → undo back to last server state left stale draft | `sceneMatchesLastSaved()` clears draft and cancels debounce when scene equals last saved | `tests/client_save_pipeline.test.ts` |
| Empty-scene draft never restored | Normalized comparison treats empty elements as valid conflict; empty client draft participates in recovery | `tests/client_save_pipeline.test.ts`, `tests/versions.test.ts` |
| Draft keys not user-scoped | `localDraftStorageKey(userId, docId)` isolates drafts per account; VIEWER bypass never reads storage | `tests/client_save_pipeline.test.ts`, `tests/recovery.test.ts` |
| Timestamp ordering compares different clocks | Conflict detection uses `serializeSceneForComparison` only; timestamps are display-only | `tests/client_save_pipeline.test.ts` |
| Restored drafts not explicitly dirty/queued | Selecting client draft replaces server scene atomically via `resolveRecoveryConflict` and mounts selected scene immediately | `tests/versions.test.ts`, `tests/recovery.test.ts` |
| Invalid and legacy drafts remain indefinitely | `decideDraftAtLoad` returns `malformed` without deleting raw value; warning shown, server scene mounted | `tests/client_save_pipeline.test.ts` |

Verification: `npm test` (117 tests) and `npm run typecheck` pass. Browser manual scenarios outstanding (see CHECKLIST).

---

## 6. Version origin labels (2026-08-31)

**Schema:** `document_versions.origin` nullable TEXT added via idempotent `ALTER TABLE ... ADD COLUMN` in `initializeSchema`. Existing rows remain `NULL` and display `Legacy / unknown`.

**Origins:**
| Origin | Source | Badge |
|---|---|---|
| `manual_save` | `POST /api/documents/[id]/save` | Manual save |
| `auto_snapshot` | `PUT /api/documents/[id]/scene` with throttled snapshot | Auto snapshot |
| `restore` | `POST /api/documents/[id]/versions?action=restore` | Restore |
| `recovery_client_draft` | Recovery `choice: server` preserve discarded client draft | Client draft |
| `recovery_server_version` | Recovery `choice: client` preserve discarded server version | Server version |
| `null` | Legacy rows | Legacy / unknown |

Origin is stored as a column, not inside scene JSON or thumbnail path, and exposed via `listVersions` / `GET /api/documents/[id]/versions`. History drawer renders badge after `Version N` using existing `bg-gray-100` style.

Validation: `tests/version_origin.test.ts` covers backward compatibility (including actual legacy file migration), each origin persistence, list/API exposure, and badge markup; full suite 117 tests and `npm run typecheck` pass.
