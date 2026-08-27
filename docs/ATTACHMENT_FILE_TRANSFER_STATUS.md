# Direct Binary Attachment Transfer — Production Status

**Date:** 2026-08-27  
**Scope:** compact scene wire format, disk attachments, client hydration, save pipeline, thumbnails  
**Code reviewed:** current working tree (includes uncommitted editor/hydration/thumbnail patches)  
**Verdict: not production ready**

The storage split is implemented and the main load/save path can work after the uncommitted client fixes. It is not ready to ship: committed `HEAD` still cannot display images correctly, the server does not enforce the fail-closed invariant, thumbnails can point at files that version GC deletes, and multipart uploads have no size cap.

---

## 1. Verdict

| Question | Answer |
|---|---|
| Is the feature implemented? | Mostly. Compact JSON, disk files, binary upload, client fetch → in-memory `dataURL`, export hydration, legacy migration, admin GC exist. |
| Does it match the design intent? | Partially. JSON/DB no longer carry image Base64. The browser still converts blobs to `data:` URLs because Excalidraw 0.18.1 `addFiles` / `image.src` require that. This is transport optimization, not URL rendering. |
| Production ready? | **No.** |

Do not deploy `origin`/`HEAD` as-is. Image load is broken there. The working-tree patches below must land first, then the must-fix items.

---

## 2. What is in good shape

These parts match the spec and have tests.

- **Compact wire on read:** `getDocumentWithScene(..., { hydrate: false })` on `GET /api/documents/[id]`, document page SSR, and `GET /api/share/[token]`. Scene `files` keep `{ id, mimeType, created }` only.
- **Export hydration isolated:** `GET /api/documents/[id]/export` uses `hydrate: true` and embeds Base64 for a portable `.excalidraw` file (`src/app/api/documents/[id]/export/route.ts`).
- **Binary upload:** `POST /api/documents/[id]/attachments` → `storeAttachment` with deterministic `fileId`, SHA-256 idempotency, 409 on content conflict, MIME allow-list, `SAFE_ID_REGEX`, path confined to `data/attachments/<docId>/`.
- **Attachment GET auth:** session permission or share token; optional `?docId=` disambiguation (`src/app/api/attachments/[attachmentId]/route.ts`).
- **Client save order:** `uploadNewAttachments` then compact JSON (`src/lib/client_save.ts`). Steady-state `/save` and `/scene` reject inline `dataURL` (`compactSceneFiles` default `allowInlineDataUrl: false`).
- **Legacy migration:** startup `migrateLegacyScenes()` extracts `data:image/` from documents and versions.
- **Tier-1 GC:** `gcUnreferencedAttachments` after save; keeps files referenced by the live scene or surviving snapshots.
- **Unit tests:** attachments, compact/hydrate, upload conflict, share compact payload, client hydration engine, compact save pipeline.

Working-tree fixes that are **required** for the editor to show images (not in `HEAD` yet):

- Do not pass compact files (no `dataURL`) into Excalidraw `initialData`. `addFiles()` skips existing ids (`node_modules/@excalidraw/excalidraw/dist/dev/index.js` `addMissingFiles`). Missing `dataURL` becomes `img.src = undefined` → `/documents/undefined`.
- Mark `hydratedIds` only after `addFiles`, so React Strict Mode abort/retry still injects files.
- localStorage drafts must not store Base64 for already-persisted files, or F5 skips `/api/attachments`.
- Dirty comparison must ignore in-memory `dataURL` so hydration is not treated as an edit.

---

## 3. Must-fix before production

### M1. Land the uncommitted client/hydration patches

Without `src/components/ExcalidrawCanvas.tsx` + `src/lib/client_attachments.ts` + draft serialization changes, production will again request `/documents/undefined` and never apply fetched binaries.

**Action:** review and commit the current working tree for those files (and matching tests) before any deploy.

### M2. Server does not enforce fail-closed persistence

Spec: a compact scene that references a `fileId` must not be saved unless that binary already exists.

`compactSceneFiles` (`src/lib/attachments.ts`):

- If `dataURL` is present and `allowInlineDataUrl` is false → 400. Good.
- If `dataURL` is absent → it still writes `{ id, mimeType, created }` and does **not** check `attachments` or disk.

A client (or crafted request) can `PUT /scene` / `POST /save` with image elements whose files were never uploaded. Load then 404s on `/api/attachments/...`. Client `uploadNewAttachments` is the only guard.

**Action:** on steady-state compact save, for every live image `fileId`, require `getAttachment(docId, fileId)` and a readable disk file; otherwise 400.

### M3. Document thumbnail path is a version file that GC can delete

`insertSnapshot` (`src/lib/versions.ts`):

```ts
const thumb = saveThumbnailFromBuffer(`${docId}-v${versionNumber}`, thumbnailBuffer);
thumbnailPath = thumb.relativePath;
saveThumbnailFromBuffer(docId, thumbnailBuffer); // also writes thumbnails/<docId>.png
db.prepare("UPDATE documents SET thumbnail_path = ? ...").run(thumbnailPath, docId);
// thumbnailPath is thumbnails/<docId>-vN.png
```

Dashboard `DocCard` uses `documents.thumbnail_path`. After 20 versions, trim calls `removeThumbnail` on old version paths. If the document still points at a trimmed `-vN.png`, the card 404s even though `thumbnails/<docId>.png` may still exist.

**Action:** store `documents.thumbnail_path` as `thumbnails/<docId>.png` only. Version rows keep `thumbnails/<docId>-vN.png`. Never GC the document-level file as a version artifact.

### M4. No upload size limit on attachments

`storeAttachment` rejects empty buffers and checks MIME, not length. JSON bodies are capped at 25 MB (`MAX_JSON_BODY_BYTES`); multipart `POST /attachments` is not. Next config has no `bodySizeLimit` for this route.

**Action:** enforce a max byte size (and optionally pixel/decode limits) in `storeAttachment` and the upload route; return 413.

### M5. Snapshots still allow inline dataURL

`insertSnapshot` always calls `compactSceneFiles(docId, scene, { allowInlineDataUrl: true })`.

`POST /save` first runs `updateScene` with the default (reject inline). If that stays true, snapshots from the editor are compact. Any other caller of `createSnapshotFromScene` / restore-from-legacy can still write Base64 into version rows through this flag.

**Action:** snapshots from `/save` and `/scene` must compact with `allowInlineDataUrl: false`. Keep `true` only for import and `migrateLegacyScenes`.

### M6. No browser-level test of Excalidraw integration

Vitest covers `hydrateSceneInMemory` with a mock `addFiles`. It did not catch:

- compact files in `initialData` making `addFiles` a no-op
- `img.src = undefined`
- localStorage draft replaying Base64

**Action:** one Playwright (or similar) case: insert image → save → hard reload → Network has `GET /api/attachments/<id>?docId=` 200 and the canvas is not `/documents/undefined`.

---

## 4. Should-fix (quality / correctness)

### S1. Thumbnail capture is easy to miss

`generateThumbnailDataURL` runs only when `isManualSave || snapshotDue`. Auto-save does not refresh the dashboard preview. `exportToBlob` uses `sceneRef.files`; if save happens before the first `onChange` after hydration, files have no `dataURL` and the PNG is placeholders. Failure is silent (`catch { return null }`) and the server falls back to `renderScenePng` stripes (`src/lib/thumbnails.ts`).

**Action:** generate the thumbnail from the Excalidraw API files after hydration; log/surface fallback; optionally refresh preview on auto-save when images change.

### S2. Attachment list requires write, not read

`GET /api/documents/[id]/attachments` uses `requireWrite`. Viewers and share-link users fetch binaries via `/api/attachments/:id` instead. Inconsistent, not the display bug.

**Action:** use `requireRead` for listing.

### S3. Crash-save beacon removed

`8b51634` removed `beforeunload` `keepalive` PUT. Recovery is localStorage only. Drafts for persisted images are now compact (good), but a full crash before auto-save still depends on quota and the draft timestamp vs `updated_at`.

**Action:** restore a compact-scene keepalive, or document that unsaved work is best-effort.

### S4. Partial hydration is silent

Failed attachment fetches are `console.warn` only. The image stays pending/error with no UI.

**Action:** show a non-blocking “n images failed to load” state.

### S5. `Cache-Control: private, max-age=31536000, immutable`

Safe only while `(docId, fileId)` content cannot change (409 on mismatch). Do not reuse fileIds for new bytes.

### S6. Existence leak on attachment GET

With `?docId=`, missing row is 404 before auth; existing row with no permission is 403.

**Action:** return 404 for both if the product cares about hiding existence.

---

## 5. Out of scope / known product limits (do not treat as bugs)

- Excalidraw will always paint from in-memory `data:` URLs. Network “Img” showing Base64 after a successful `/api/attachments` fetch is expected.
- `renderScenePng` is a colored-stripe placeholder, not a scene rasterizer. Real previews require client `exportToBlob` (working-tree restore).
- Server-side scene JSON APIs are not supposed to return image Base64 except export.

---

## 6. Suggested action order

1. Commit working-tree hydration, draft, and thumbnail patches; do not deploy without them.
2. M2 fail-closed check on `/save` and `/scene`.
3. M3 thumbnail path vs version GC.
4. M4 upload size cap.
5. M5 snapshot `allowInlineDataUrl: false` on the editor save path.
6. M6 one real-browser reload test.
7. Then S1–S4 as polish.

Until 1–5 are done, treat this as **development-only**.
