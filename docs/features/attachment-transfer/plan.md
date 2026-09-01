# Implementation Plan: Direct Binary Attachment Transfer

- **Worker Sub-skill Note:** This plan is the authoritative specification for subsequent worker implementation dispatches. Every task must be executed strictly with failing tests (red), minimal implementation (green), and atomic local commits without scope deviation.
- **Goal:** Replace server-side Base64 JSON parsing with direct binary attachment transfer, in-memory client hydration via Excalidraw's imperative API, pre-upload on save, and two-tier admin storage GC.
- **Architecture:** Client uploads new image binaries directly via multipart/binary endpoints before submitting compact JSON scene payloads. On load, client fetches raw binaries and hydrates them into Excalidraw runtime memory only. Two-tier GC handles immediate post-save cleanup (Tier 1) and 24-hour grace-period unreferenced DB row cleanup (Tier 2). Export remains the sole server-side hydration path.
- **Tech Stack:** Next.js 15 App Router, React 18, `@excalidraw/excalidraw` 0.18.1, Node.js SQLite (`node:sqlite`), TypeScript, Vitest.
- **Spec Reference:** `docs/features/attachment-transfer/design.md`
- **Global Constraints:**
  - Zero Base64 `dataURL` over steady-state document JSON APIs (`/api/documents/[id]`, `/api/documents/[id]/save`, `/api/documents/[id]/scene`, `/api/share/[token]`).
  - No saving a compact scene referencing an unpersisted attachment file ID.
  - Snapshot-safe retention: attachments referenced in any surviving version snapshot are never purged.
  - Document-scoped database primary key: `PRIMARY KEY (document_id, id)`.
  - No push, fetch, merge, force-push, or remote branch changes. Commit locally only.

---

## 1. Data Types & Produced Interfaces

```typescript
// src/lib/types.ts
export interface CompactBinaryFile {
  id: string;        // Excalidraw FileId (e.g. "file_abc123")
  mimeType: string;  // e.g. "image/png"
  created: number;   // Unix timestamp in ms
  byteSize?: number; // File size in bytes
  version?: number;
  // dataURL is deliberately omitted / undefined on wire
}

export interface CompactScene {
  type: "excalidraw";
  version: 2;
  source?: string;
  elements: readonly unknown[];
  appState: Partial<unknown>;
  files: Record<string, CompactBinaryFile>;
}

// src/lib/client_attachments.ts
export interface HydrationOptions {
  docId: string;
  shareToken?: string;
  concurrency?: number; // default: 4
}

export interface ClientHydratedFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

// src/lib/storage_maintenance.ts
export interface UnreferencedAttachmentItem {
  documentId: string;
  attachmentId: string;
  fileName: string;
  filePath: string;
  byteSize: number;
  createdAt: string;
  ageSeconds: number;
}
```

---

## 2. Implementation Tasks

### Task 1: Server Compact-Wire Contract, Compact Read Helper, and Standalone Export Hydration

- **Files:**
  - `src/lib/documents.ts`
  - `src/app/api/documents/[id]/route.ts`
  - `src/app/api/documents/[id]/export/route.ts`
  - `src/app/api/share/[token]/route.ts`
  - `src/app/documents/[id]/page.tsx`
  - `tests/documents.test.ts`
  - `tests/share.test.ts`
  - `tests/export_import.test.ts`

- **Consumed/Produced Interfaces:**
  ```typescript
  // src/lib/documents.ts
  export function getDocumentWithScene(
    docId: string,
    userId?: string,
    role?: "USER" | "ADMIN",
    adminMode?: boolean,
    options?: { hydrate?: boolean },
  ): { doc: DocumentRow; scene: ExcalidrawScene; permission: Permission };
  ```

- **Steps:**
  - [ ] **Step 1.1: Write failing test in `tests/documents.test.ts` and `tests/share.test.ts`**
    - Add test: `it("should return compact scene without dataURL in GET /api/documents/[id] and GET /api/share/[token]")`
    - Add test in `tests/export_import.test.ts`: `it("should return fully hydrated standalone scene with dataURL on GET /api/documents/[id]/export")`
  - [ ] **Step 1.2: Run test to observe failure**
    - Command: `npx vitest run tests/documents.test.ts -t "without dataURL"`
    - Expected: Fails with `AssertionError: expected 'data:image/png;base64,...' to be undefined`
  - [ ] **Step 1.3: Implement compact read helper and export hydration**
    - In `src/lib/documents.ts`:
      - Update `getDocumentWithScene(docId, userId, role = "USER", adminMode = false, options = { hydrate: false })`.
      - When `options.hydrate !== true`, return `rawScene = jsonToScene(doc.scene)` directly without calling `hydrateSceneFiles()`.
    - In `src/app/api/documents/[id]/route.ts`:
      - Call `getDocumentWithScene(id, user.id, user.role, adminMode, { hydrate: false })`.
    - In `src/app/api/share/[token]/route.ts`:
      - Remove `hydrateSceneFiles()`, return `jsonToScene(doc.scene)` directly.
    - In `src/app/documents/[id]/page.tsx`:
      - Pass compact `scene` to `EditorClient`.
    - In `src/app/api/documents/[id]/export/route.ts`:
      - Explicitly call `getDocumentWithScene(id, user.id, user.role, adminMode, { hydrate: true })` so exported files retain embedded Base64 for offline portability.
  - [ ] **Step 1.4: Run test to confirm pass**
    - Command: `npx vitest run tests/documents.test.ts tests/share.test.ts tests/export_import.test.ts`
    - Expected: All tests pass cleanly.
  - [ ] **Step 1.5: Commit locally**
    - Command: `git add src/lib/documents.ts src/app/api/documents/[id]/route.ts src/app/api/documents/[id]/export/route.ts src/app/api/share/[token]/route.ts src/app/documents/[id]/page.tsx tests/documents.test.ts tests/share.test.ts tests/export_import.test.ts && git commit -m "feat(api): enforce compact scene wire contract and preserve export hydration"`

---

### Task 2: Deterministic, Idempotent Document-Scoped Binary Upload API & Write Rejection Guard

- **Files:**
  - `src/app/api/documents/[id]/attachments/route.ts`
  - `src/lib/attachments.ts`
  - `src/app/api/documents/[id]/save/route.ts`
  - `src/app/api/documents/[id]/scene/route.ts`
  - `tests/export_import.test.ts`
  - `tests/documents.test.ts`

- **Consumed/Produced Interfaces:**
  ```typescript
  // src/lib/attachments.ts
  export function storeAttachment(
    docId: string,
    fileName: string,
    mimeType: string,
    data: Buffer,
    customFileId?: string,
  ): AttachmentRow;

  export function compactSceneFiles(
    docId: string,
    scene: ExcalidrawScene,
    options?: { allowInlineDataUrl?: boolean },
  ): ExcalidrawScene;
  ```

- **Steps:**
  - [ ] **Step 2.1: Write failing test in `tests/export_import.test.ts`**
    - Add test: `it("should store attachment with deterministic fileId idempotently and reject inline dataURL on steady-state save")`
  - [ ] **Step 2.2: Run test to observe failure**
    - Command: `npx vitest run tests/export_import.test.ts -t "deterministic fileId"`
    - Expected: Fails because `fileId` form field is ignored and generates a random UUID.
  - [ ] **Step 2.3: Implement deterministic upload and steady-state save guard**
    - In `src/lib/attachments.ts`:
      - Update `storeAttachment(docId, fileName, mimeType, data, customFileId)`:
        - If `customFileId` is provided, validate with `SAFE_ID_REGEX` and use as `id`.
        - Check if `(docId, customFileId)` already exists; if hash/size matches, return existing row (idempotent).
        - If different content exists under same `id`, overwrite disk file and update `sha256`, `file_size`, `updated_at`.
      - Update `compactSceneFiles(docId, scene, { allowInlineDataUrl = false })`:
        - If `!allowInlineDataUrl` and any `file.dataURL` is a Base64 string longer than 512 bytes, throw `HttpError(400, "Inline dataURL prohibited in steady-state; upload binaries directly")`.
    - In `src/app/api/documents/[id]/attachments/route.ts`:
      - Extract `fileId = form.get("fileId")` if present and pass to `storeAttachment()`.
    - In `src/app/api/documents/[id]/save/route.ts` & `src/app/api/documents/[id]/scene/route.ts`:
      - Remove `thumbnailBase64` processing from body; generate thumbnail via server `saveThumbnail(id, scene)`.
  - [ ] **Step 2.4: Run test to confirm pass**
    - Command: `npx vitest run tests/export_import.test.ts tests/documents.test.ts`
    - Expected: All tests pass cleanly.
  - [ ] **Step 2.5: Commit locally**
    - Command: `git add src/lib/attachments.ts src/app/api/documents/[id]/attachments/route.ts src/app/api/documents/[id]/save/route.ts src/app/api/documents/[id]/scene/route.ts tests/export_import.test.ts tests/documents.test.ts && git commit -m "feat(attachments): add deterministic binary upload and reject steady-state inline dataURL"`

---

### Task 3: Client In-Memory Binary Hydration Engine & Canvas/Share Integration

- **Files:**
  - `src/lib/client_attachments.ts` (new)
  - `src/components/ExcalidrawCanvas.tsx`
  - `src/app/share/[token]/ShareViewer.tsx`
  - `tests/client_attachments.test.ts` (new)

- **Consumed/Produced Interfaces:**
  ```typescript
  // src/lib/client_attachments.ts
  export interface HydrationOptions {
    docId: string;
    shareToken?: string;
    concurrency?: number;
  }

  export async function hydrateSceneInMemory(
    scene: ExcalidrawScene,
    api: ExcalidrawImperativeAPI,
    options: HydrationOptions,
  ): Promise<void>;
  ```

- **Steps:**
  - [ ] **Step 3.1: Write failing test in `tests/client_attachments.test.ts`**
    - Add unit tests verifying `hydrateSceneInMemory` batches binary GET requests, converts `Blob`s to in-memory `dataURL`, catches 404s gracefully, and calls `api.addFiles`.
  - [ ] **Step 3.2: Run test to observe failure**
    - Command: `npx vitest run tests/client_attachments.test.ts`
    - Expected: Fails with `Cannot find module '@/lib/client_attachments'`.
  - [ ] **Step 3.3: Implement `client_attachments.ts` and integrate with `ExcalidrawCanvas`**
    - Create `src/lib/client_attachments.ts`:
      - Identify unhydrated files: `Object.entries(scene.files).filter(([id, f]) => !f.dataURL)`.
      - Construct URL: `options.shareToken ? /api/attachments/${id}?docId=${options.docId}&token=${options.shareToken} : /api/attachments/${id}?docId=${options.docId}`.
      - Limit concurrency to 4 using batch chunks (`for (let i = 0; i < files.length; i += 4)`).
      - Convert `res.blob()` to Base64 using `FileReader.readAsDataURL()`.
      - Catch errors per file (e.g. 404 missing) without breaking other files.
      - Call `api.addFiles(hydratedFilesList)`.
    - Update `src/components/ExcalidrawCanvas.tsx`:
      - Accept `docId?: string` and `shareToken?: string` in props.
      - Call `hydrateSceneInMemory` on API mount and when `initialScene` updates.
    - Update `src/app/share/[token]/ShareViewer.tsx`:
      - Pass `docId={data.document.id}` and `shareToken={token}` to `ExcalidrawCanvas`.
  - [ ] **Step 3.4: Run test to confirm pass**
    - Command: `npx vitest run tests/client_attachments.test.ts && npm run typecheck`
    - Expected: All tests pass cleanly, 0 TypeScript errors.
  - [ ] **Step 3.5: Commit locally**
    - Command: `git add src/lib/client_attachments.ts src/components/ExcalidrawCanvas.tsx src/app/share/[token]/ShareViewer.tsx tests/client_attachments.test.ts && git commit -m "feat(client): implement in-memory binary hydration engine and canvas integration"`

---

### Task 4: Editor Save Pipeline Refactoring (Pre-Upload Flow & Mutex Lock)

- **Files:**
  - `src/app/documents/[id]/EditorClient.tsx`
  - `src/lib/client.ts`

- **Consumed/Produced Interfaces:**
  ```typescript
  // src/app/documents/[id]/EditorClient.tsx
  interface SavePipelineOptions {
    docId: string;
    scene: ExcalidrawScene;
    persistedFileIds: Set<string>;
  }
  ```

- **Steps:**
  - [ ] **Step 4.1: Write failing test in `tests/documents.test.ts` for save pipeline**
    - Add test: `it("should reject save containing unpersisted fileId until binary attachment is uploaded")`
  - [ ] **Step 4.2: Run test to observe failure**
    - Command: `npx vitest run tests/documents.test.ts -t "unpersisted fileId"`
    - Expected: Fails as existing endpoint accepted inline payload.
  - [ ] **Step 4.3: Refactor `EditorClient.tsx` save workflow**
    - Maintain `persistedFileIds = useRef<Set<string>>(new Set(Object.keys(initialScene.files || {})))`.
    - Maintain `isSavingRef = useRef<boolean>(false)` to prevent overlapping concurrent save requests.
    - In `saveDoc()` / auto-save handler:
      1. If `isSavingRef.current` is true, queue next save or return.
      2. Set `isSavingRef.current = true`.
      3. Find newly added files: `Object.entries(scene.files).filter(([id]) => !persistedFileIds.current.has(id))`.
      4. For each new file:
         - Convert in-memory `file.dataURL` to `Blob` via `fetch(file.dataURL).then(r => r.blob())`.
         - Create `FormData`: append `file`, append `fileId: id`.
         - Send `POST /api/documents/${docId}/attachments`.
         - If failed, throw Error, stop save sequence, mark UI as `Save Error`, and retain dirty state in browser.
         - On 200/201 response, add `id` to `persistedFileIds.current`.
      5. Construct `compactScene` by stripping `dataURL` from all `scene.files`.
      6. Send `POST /api/documents/${docId}/save` with `{ scene: compactScene }` (no `thumbnailBase64`).
      7. Reset `isSavingRef.current = false`.
    - Remove Base64 `beforeunload` beacon; preserve `localStorage` draft saving for crash recovery.
  - [ ] **Step 4.4: Run test to confirm pass**
    - Command: `npm run typecheck && npx vitest run tests/documents.test.ts`
    - Expected: Typecheck and tests pass.
  - [ ] **Step 4.5: Commit locally**
    - Command: `git add src/app/documents/[id]/EditorClient.tsx tests/documents.test.ts && git commit -m "feat(editor): refactor save pipeline to pre-upload binaries and eliminate thumbnailBase64"`

---

### Task 5: Two-Tier Storage Maintenance & 24-Hour Grace Period Unreferenced DB Row Cleanup

- **Files:**
  - `src/lib/storage_maintenance.ts`
  - `tests/storage_maintenance.test.ts`

- **Consumed/Produced Interfaces:**
  ```typescript
  // src/lib/storage_maintenance.ts
  export interface UnreferencedAttachmentItem {
    documentId: string;
    attachmentId: string;
    fileName: string;
    filePath: string;
    byteSize: number;
    createdAt: string;
    ageSeconds: number;
  }

  export function scanStorage(): StorageScanReport;
  export function cleanUnreferencedAttachments(confirm: boolean): {
    deletedRows: number;
    deletedFiles: string[];
    reclaimedBytes: number;
  };
  ```

- **Steps:**
  - [ ] **Step 5.1: Write failing tests in `tests/storage_maintenance.test.ts`**
    - Add test: `it("should identify unreferenced attachment rows older than 24 hours while ignoring recent uploads within grace period")`
    - Add test: `it("should safely purge unreferenced attachment DB rows and regular disk files upon confirmation without deleting missing-file rows or symlinks")`
  - [ ] **Step 5.2: Run test to observe failure**
    - Command: `npx vitest run tests/storage_maintenance.test.ts -t "unreferenced attachment rows"`
    - Expected: Fails because `unreferencedAttachments` is undefined on `StorageScanReport`.
  - [ ] **Step 5.3: Implement Tier 2 unreferenced attachment scanning & safe cleanup**
    - In `src/lib/storage_maintenance.ts`:
      - Define `const UNREFERENCED_GRACE_PERIOD_SECONDS = 86400;` (24h).
      - In `scanStorage()`:
        - Query all `attachments` table rows.
        - Collect all referenced `(document_id, fileId)` pairs from all active `documents.scene` and all `document_versions.scene`.
        - Filter rows where `!referencedSet.has(docId + ":" + id)`.
        - Calculate `ageSeconds = (Date.now() - new Date(row.created_at).getTime()) / 1000`.
        - Populate `unreferencedAttachments`:
          - `items`: array of `UnreferencedAttachmentItem` where `ageSeconds >= UNREFERENCED_GRACE_PERIOD_SECONDS`.
          - `totalCount`: `items.length`.
          - `totalBytes`: sum of `byteSize`.
          - `gracePeriodSeconds`: `86400`.
      - In `cleanUnreferencedAttachments(confirm)`:
        - If `!confirm`, throw `HttpError(400, "Explicit confirmation required")`.
        - Rescan storage immediately to prevent race conditions.
        - For each eligible unreferenced candidate:
          - Resolve path via `resolveAttachmentFilesystem(row)`.
          - Check if physical file exists and is regular file: `existsSync(abs) && !lstatSync(abs).isSymbolicLink() && statSync(abs).isFile()`.
          - If file exists, delete file via `unlinkSync(abs)`.
          - Delete row via `db.prepare("DELETE FROM attachments WHERE document_id = ? AND id = ?").run(row.documentId, row.attachmentId)`.
          - Clean empty parent directory `data/attachments/${row.documentId}`.
  - [ ] **Step 5.4: Run test to confirm pass**
    - Command: `npx vitest run tests/storage_maintenance.test.ts`
    - Expected: All 10 tests in `storage_maintenance.test.ts` pass cleanly.
  - [ ] **Step 5.5: Commit locally**
    - Command: `git add src/lib/storage_maintenance.ts tests/storage_maintenance.test.ts && git commit -m "feat(admin): implement tier 2 storage maintenance for unreferenced DB attachments with 24h grace period"`

---

### Task 6: Admin Storage API & Dashboard UI Integration

- **Files:**
  - `src/app/api/admin/storage/route.ts`
  - `src/app/dashboard/StoragePanel.tsx`

- **Consumed/Produced Interfaces:**
  ```typescript
  // src/app/api/admin/storage/route.ts
  export type StorageAction = "cleanup" | "cleanup-unreferenced" | "vacuum";
  ```

- **Steps:**
  - [ ] **Step 6.1: Write failing test in `tests/storage_maintenance.test.ts` for API route**
    - Add test: `it("should support POST /api/admin/storage with action: cleanup-unreferenced and confirm: true")`
  - [ ] **Step 6.2: Run test to observe failure**
    - Command: `npx vitest run tests/storage_maintenance.test.ts -t "cleanup-unreferenced"`
    - Expected: Fails with `400 Invalid action`.
  - [ ] **Step 6.3: Update API route and StoragePanel UI**
    - In `src/app/api/admin/storage/route.ts`:
      - Handle `body.action === "cleanup-unreferenced"`:
        - If `!body.confirm`, return `jsonError("Confirmation required", 400)`.
        - Call `cleanUnreferencedAttachments(true)`.
        - Return `json({ deletedRows: res.deletedRows, deletedFiles: res.deletedFiles, reclaimedBytes: res.reclaimedBytes })`.
    - In `src/app/dashboard/StoragePanel.tsx`:
      - Add Overview metric card: `Unreferenced DB Attachments (>24h)`.
      - Add Table listing unreferenced attachment records (Doc ID, File ID, Size, Age).
      - Add Action button: `[Purge Unreferenced Attachments]` with confirmation modal explaining 24h grace period.
  - [ ] **Step 6.4: Run test to confirm pass**
    - Command: `npx vitest run tests/storage_maintenance.test.ts && npm run typecheck`
    - Expected: All tests pass, 0 TypeScript errors.
  - [ ] **Step 6.5: Commit locally**
    - Command: `git add src/app/api/admin/storage/route.ts src/app/dashboard/StoragePanel.tsx tests/storage_maintenance.test.ts && git commit -m "feat(admin): integrate unreferenced attachment cleanup API and dashboard UI"`

---

### Task 7: Full Regression & Real Browser E2E Network Verification

- **Files:**
  - All project test suites
  - Local browser verification script

- **Steps:**
  - [ ] **Step 7.1: Execute complete project test suite**
    - Command: `npm test`
    - Expected: All unit and integration test suites pass (100% green).
  - [ ] **Step 7.2: Run TypeScript typecheck**
    - Command: `npm run typecheck`
    - Expected: `tsc --noEmit` exits with 0 errors.
  - [ ] **Step 7.3: Run production dependency audit**
    - Command: `npm audit --omit=dev`
    - Expected: `found 0 vulnerabilities`.
  - [ ] **Step 7.4: Execute standalone production build**
    - Command: `npm run build`
    - Expected: Next.js 15 production build succeeds cleanly.
  - [ ] **Step 7.5: Commit locally**
    - Command: `git commit --allow-empty -m "chore: verify complete direct attachment transfer implementation pipeline"`

---

## 3. Verification & Acceptance Criteria

1. **Network Payload Verification:**
   - On `GET /api/documents/[id]` and `GET /api/share/[token]`, scene JSON payload contains 0 Base64 `dataURL` bytes.
   - Images on canvas trigger distinct `GET /api/attachments/[fileId]?docId=[id]` binary requests.
2. **Persistence Integrity:**
   - Saving a scene with newly pasted/dropped images succeeds without Base64 in `POST /api/documents/[id]/save` payload.
   - Retried saves after network drops do not duplicate existing attachment files.
3. **Storage GC Safety:**
   - Tier 1 GC removes unreferenced images from disk and DB immediately after successful save if not retained in snapshots.
   - Tier 2 GC purges abandoned DB rows older than 24 hours only upon explicit admin confirmation.
   - Missing-file rows and symlinks are never deleted.
