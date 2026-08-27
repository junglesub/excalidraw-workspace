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
