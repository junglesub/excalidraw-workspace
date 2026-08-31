# Local Draft Recovery Conflict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add load-time client/server draft conflict selection that preserves the unselected writable version as a snapshot by default and never silently discards recovery data.

**Architecture:** Pure helpers in `client_save.ts` normalize scenes, parse user-scoped drafts, and drive deterministic load decisions. A single write-authorized recovery endpoint delegates to an atomic domain operation in `versions.ts`; the editor blocks canvas mounting until the user resolves a mismatch, while viewers always receive the server scene without reading localStorage.

**Tech Stack:** Next.js 15 App Router, React 18, TypeScript 5.5, `@excalidraw/excalidraw` 0.18.1, Node built-in `node:sqlite`, Vitest 2.1, existing multipart attachment API.

**Spec:** `docs/superpowers/specs/2026-08-31-local-draft-recovery-conflict-design.md`

## Global Constraints

- Apply conflict handling only while loading or refreshing a document; do not add live collaboration conflict detection.
- `VIEWER` and non-writable documents must show the server scene without reading, changing, or deleting local draft storage.
- Compare normalized content, never client/server timestamps, to decide whether a mismatch exists.
- Preserve the unselected version by default; remove the local draft only after the complete selected flow succeeds.
- Keep steady-state scene APIs compact: no inline `dataURL` in recovery JSON.
- Reuse the current attachment upload, 20-snapshot retention, thumbnail, and attachment-GC behavior.
- Do not add packages, new storage tables, scene previews, visual diffs, or a legacy-draft migration UI.
- Do not run `npm run build`; verification is limited to targeted tests, the full test suite, typecheck, and manual browser checks.

---

## File Map

| File | Responsibility |
|---|---|
| `src/lib/client_save.ts` | User-scoped key, draft parser, normalized comparison, summaries, and recovery HTTP orchestration. |
| `src/lib/versions.ts` | Atomic preservation snapshot and selected-scene application. |
| `src/app/api/documents/[id]/recovery/route.ts` | Authentication, request validation, recovery response contract, and `409` response. |
| `src/components/RecoveryConflictModal.tsx` | Blocking, accessible conflict chooser with the default-enabled preservation checkbox. |
| `src/app/documents/[id]/EditorClient.tsx` | Load gate, viewer bypass, modal state, resolution flow, scoped draft lifecycle, and stale-draft cleanup. |
| `tests/client_save_pipeline.test.ts` | Pure draft decisions, normalization, upload ordering, and recovery transport. |
| `tests/versions.test.ts` | Atomic domain behavior, rollback, retention, and selected/unselected scene assertions. |
| `tests/recovery.test.ts` | Recovery route validation, permissions, success contract, and `409` contract. |
| `tests/recovery_modal.test.ts` | Static accessible markup and required controls without adding a browser-test dependency. |
| `docs/ATTACHMENT_FILE_TRANSFER_STATUS.md` | Implemented status and verification evidence. |
| `docs/CHECKLIST.md` | Regression scenarios and manual browser acceptance checks. |

---

### Task 1: Deterministic Draft Keys, Parsing, Comparison, and Load Decisions

**Files:**
- Modify: `src/lib/client_save.ts:31-121`
- Modify: `tests/client_save_pipeline.test.ts:269-316`

**Interfaces:**
- Consumes: existing `ExcalidrawScene`, `serializeSceneForComparison()`, and `getActiveImageFileIds()`.
- Produces:

```typescript
export interface LocalDraftEnvelope {
  scene: ExcalidrawScene;
  updatedAt: number;
}

export interface RecoverySceneSummary {
  updatedAt: number | string;
  elementCount: number;
  imageCount: number;
}

export type DraftLoadDecision =
  | { kind: "server" }
  | { kind: "equal" }
  | { kind: "conflict"; draft: LocalDraftEnvelope }
  | { kind: "malformed" };

export function localDraftStorageKey(userId: string, docId: string): string;
export function decideDraftAtLoad(raw: string | null, serverScene: ExcalidrawScene): DraftLoadDecision;
export function decideDraftForAccess(
  canEdit: boolean,
  readDraft: () => string | null,
  serverScene: ExcalidrawScene,
): DraftLoadDecision;
export function summarizeRecoveryScene(
  scene: ExcalidrawScene,
  updatedAt: number | string,
): RecoverySceneSummary;
```

- [ ] **Step 1: Write failing tests for user isolation and normalized decisions**

Append these cases to `tests/client_save_pipeline.test.ts`:

```typescript
import {
  decideDraftForAccess,
  decideDraftAtLoad,
  localDraftStorageKey,
  summarizeRecoveryScene,
} from "@/lib/client_save";

it("uses user- and document-scoped local draft keys", () => {
  expect(localDraftStorageKey("user-a", "doc-1")).toBe("excalidraw_draft_user-a_doc-1");
  expect(localDraftStorageKey("user-a", "doc-1")).not.toBe(
    localDraftStorageKey("user-b", "doc-1"),
  );
});

it("does not read draft storage without write access", () => {
  const readDraft = vi.fn(() => JSON.stringify({ scene: emptyScene(), updatedAt: 1 }));
  expect(decideDraftForAccess(false, readDraft, emptyScene())).toEqual({ kind: "server" });
  expect(readDraft).not.toHaveBeenCalled();
});

it("detects any normalized mismatch regardless of timestamps and accepts an empty draft", () => {
  const server = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
  const emptyDraft = JSON.stringify({ scene: emptyScene(), updatedAt: 1 });

  const decision = decideDraftAtLoad(emptyDraft, server);
  expect(decision.kind).toBe("conflict");
});

it("treats hydration-only dataURL differences and file insertion order as equal", () => {
  const server: ExcalidrawScene = {
    ...emptyScene(),
    elements: [
      { id: "a", type: "image", fileId: "f-a", isDeleted: false },
      { id: "b", type: "image", fileId: "f-b", isDeleted: false },
    ],
    files: {
      "f-a": { id: "f-a", mimeType: "image/png", created: 1 },
      "f-b": { id: "f-b", mimeType: "image/png", created: 2 },
    },
  };
  const draft = {
    ...server,
    files: {
      "f-b": { id: "f-b", mimeType: "image/png", created: 2, dataURL: "data:image/png;base64,QQ==" },
      "f-a": { id: "f-a", mimeType: "image/png", created: 1, dataURL: "data:image/png;base64,QQ==" },
    },
  };

  expect(decideDraftAtLoad(JSON.stringify({ scene: draft, updatedAt: 999 }), server)).toEqual({
    kind: "equal",
  });
});

it("preserves malformed and legacy values as non-recoverable decisions", () => {
  expect(decideDraftAtLoad("{broken", emptyScene())).toEqual({ kind: "malformed" });
  expect(decideDraftAtLoad(JSON.stringify(emptyScene()), emptyScene())).toEqual({ kind: "malformed" });
});

it("summarizes total elements and active images for the conflict dialog", () => {
  const scene: ExcalidrawScene = {
    ...emptyScene(),
    elements: [
      { id: "rect", type: "rectangle" },
      { id: "live", type: "image", fileId: "live-file", isDeleted: false },
      { id: "deleted", type: "image", fileId: "deleted-file", isDeleted: true },
    ],
  };
  expect(summarizeRecoveryScene(scene, 123)).toEqual({
    updatedAt: 123,
    elementCount: 3,
    imageCount: 1,
  });
});
```

Also add `emptyScene` to the existing import from `@/lib/types`.

- [ ] **Step 2: Run the targeted tests and verify the new imports fail**

Run:

```powershell
npm test -- tests/client_save_pipeline.test.ts
```

Expected: FAIL because `localDraftStorageKey`, `decideDraftAtLoad`, `decideDraftForAccess`, and `summarizeRecoveryScene` are not exported.

- [ ] **Step 3: Implement deterministic comparison and draft decisions**

In `serializeSceneForComparison()`, sort compact file entries by file ID before `JSON.stringify`:

```typescript
const sortedFiles = Object.fromEntries(
  Object.entries(compact.files || {}).sort(([left], [right]) => left.localeCompare(right)),
);
```

Use `files: sortedFiles` in the serialized object. Add the produced interfaces and functions:

```typescript
export function localDraftStorageKey(userId: string, docId: string): string {
  return `excalidraw_draft_${userId}_${docId}`;
}

export function decideDraftAtLoad(
  raw: string | null,
  serverScene: ExcalidrawScene,
): DraftLoadDecision {
  if (raw === null) return { kind: "server" };
  try {
    const parsed = JSON.parse(raw) as Partial<LocalDraftEnvelope>;
    if (
      !parsed.scene ||
      typeof parsed.scene !== "object" ||
      !Array.isArray(parsed.scene.elements) ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return { kind: "malformed" };
    }
    const draft = parsed as LocalDraftEnvelope;
    return serializeSceneForComparison(draft.scene) === serializeSceneForComparison(serverScene)
      ? { kind: "equal" }
      : { kind: "conflict", draft };
  } catch {
    return { kind: "malformed" };
  }
}

export function decideDraftForAccess(
  canEdit: boolean,
  readDraft: () => string | null,
  serverScene: ExcalidrawScene,
): DraftLoadDecision {
  return canEdit ? decideDraftAtLoad(readDraft(), serverScene) : { kind: "server" };
}

export function summarizeRecoveryScene(
  scene: ExcalidrawScene,
  updatedAt: number | string,
): RecoverySceneSummary {
  return {
    updatedAt,
    elementCount: Array.isArray(scene.elements) ? scene.elements.length : 0,
    imageCount: getActiveImageFileIds(scene).size,
  };
}
```

- [ ] **Step 4: Run the targeted tests and confirm they pass**

Run:

```powershell
npm test -- tests/client_save_pipeline.test.ts
```

Expected: `tests/client_save_pipeline.test.ts` passes with zero failures.

- [ ] **Step 5: Commit the pure draft contract**

```powershell
git add -- "src/lib/client_save.ts" "tests/client_save_pipeline.test.ts"
git commit -m "feat(editor): add deterministic local draft decisions"
```

---

### Task 2: Atomic Recovery Resolution Domain Operation

**Files:**
- Modify: `src/lib/versions.ts:20-202`
- Modify: `tests/versions.test.ts`

**Interfaces:**
- Consumes: `compactSceneFiles()`, `gcUnreferencedAttachments()`, `requireWrite()`, `insertSnapshot()`, `transaction()`, and `DocumentRow.updated_at`.
- Produces:

```typescript
export interface ResolveRecoveryConflictInput {
  choice: "client" | "server";
  preserveDiscarded: boolean;
  expectedServerUpdatedAt: string;
  clientScene: ExcalidrawScene;
  thumbnailBuffer?: Buffer | null;
}

export type ResolveRecoveryConflictResult =
  | {
      ok: true;
      choice: "client" | "server";
      snapshotCreated: boolean;
      updatedAt: string;
    }
  | {
      ok: false;
      code: "SERVER_VERSION_CHANGED";
      serverScene: ExcalidrawScene;
      serverUpdatedAt: string;
    };

export function resolveRecoveryConflict(
  docId: string,
  actorId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
  input: ResolveRecoveryConflictInput,
): ResolveRecoveryConflictResult;
```

- [ ] **Step 1: Write failing domain tests for both choices, unchecked preservation, conflict, and rollback**

Add imports for `getDb`, `resolveRecoveryConflict`, and `sceneToJson`. Append these tests to `tests/versions.test.ts`:

```typescript
it("snapshots the server scene before selecting the client scene", () => {
  const user = createUser("alice", "pass123", "USER");
  const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
  const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
  const doc = createDocument(user.id, serverScene, "Conflict Doc");

  const result = resolveRecoveryConflict(doc.id, user.id, "USER", false, {
    choice: "client",
    preserveDiscarded: true,
    expectedServerUpdatedAt: doc.updated_at,
    clientScene,
  });

  expect(result.ok).toBe(true);
  expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(clientScene.elements);
  const snapshot = getDb()
    .prepare("SELECT scene FROM document_versions WHERE document_id = ?")
    .get(doc.id) as { scene: string };
  expect(jsonToScene(snapshot.scene).elements).toEqual(serverScene.elements);
});

it("snapshots the client scene while keeping the server scene", () => {
  const user = createUser("alice", "pass123", "USER");
  const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
  const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
  const doc = createDocument(user.id, serverScene, "Conflict Doc");

  resolveRecoveryConflict(doc.id, user.id, "USER", false, {
    choice: "server",
    preserveDiscarded: true,
    expectedServerUpdatedAt: doc.updated_at,
    clientScene,
  });

  expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(serverScene.elements);
  const snapshot = getDb()
    .prepare("SELECT scene FROM document_versions WHERE document_id = ?")
    .get(doc.id) as { scene: string };
  expect(jsonToScene(snapshot.scene).elements).toEqual(clientScene.elements);
});

it("creates no snapshot when preservation is disabled", () => {
  const user = createUser("alice", "pass123", "USER");
  const doc = createDocument(user.id, emptyScene(), "Conflict Doc");
  resolveRecoveryConflict(doc.id, user.id, "USER", false, {
    choice: "server",
    preserveDiscarded: false,
    expectedServerUpdatedAt: doc.updated_at,
    clientScene: {
      ...emptyScene(),
      elements: [{ id: "discarded", type: "image", fileId: "never-uploaded", isDeleted: false }],
      files: {
        "never-uploaded": {
          id: "never-uploaded",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,QQ==",
          created: 1,
        },
      },
    },
  });
  expect(listVersions(doc.id)).toHaveLength(0);
});

it("updates to the client scene without a snapshot when preservation is disabled", () => {
  const user = createUser("alice", "pass123", "USER");
  const doc = createDocument(user.id, emptyScene(), "Conflict Doc");
  const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
  resolveRecoveryConflict(doc.id, user.id, "USER", false, {
    choice: "client",
    preserveDiscarded: false,
    expectedServerUpdatedAt: doc.updated_at,
    clientScene,
  });
  expect(listVersions(doc.id)).toHaveLength(0);
  expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(clientScene.elements);
});

it("returns the latest server scene without mutation when the version token changed", () => {
  const user = createUser("alice", "pass123", "USER");
  const doc = createDocument(user.id, emptyScene(), "Conflict Doc");
  const latest = { ...emptyScene(), elements: [{ id: "latest", type: "diamond" }] };
  getDb()
    .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
    .run(sceneToJson(latest), "2099-01-01T00:00:00.000Z", doc.id);

  const result = resolveRecoveryConflict(doc.id, user.id, "USER", false, {
    choice: "client",
    preserveDiscarded: true,
    expectedServerUpdatedAt: doc.updated_at,
    clientScene: { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] },
  });

  expect(result).toMatchObject({
    ok: false,
    code: "SERVER_VERSION_CHANGED",
    serverUpdatedAt: "2099-01-01T00:00:00.000Z",
  });
  expect(listVersions(doc.id)).toHaveLength(0);
  expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(latest.elements);
});

it("rolls back both snapshot and document update when the client scene is invalid", () => {
  const user = createUser("alice", "pass123", "USER");
  const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
  const doc = createDocument(user.id, serverScene, "Conflict Doc");
  const missingFileScene: ExcalidrawScene = {
    ...emptyScene(),
    elements: [{ id: "image", type: "image", fileId: "missing-file", isDeleted: false }],
    files: { "missing-file": { id: "missing-file", mimeType: "image/png", created: 1 } },
  };

  expect(() =>
    resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "client",
      preserveDiscarded: true,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene: missingFileScene,
    }),
  ).toThrow(/attachment/i);
  expect(listVersions(doc.id)).toHaveLength(0);
  expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(serverScene.elements);
});
```

- [ ] **Step 2: Run the domain tests and verify the missing export fails**

Run:

```powershell
npm test -- tests/versions.test.ts
```

Expected: FAIL because `resolveRecoveryConflict` is not exported.

- [ ] **Step 3: Implement one transaction with captured server content**

In `src/lib/versions.ts`, add the interfaces and `resolveRecoveryConflict()`. The implementation must validate attachments whenever the client scene will be saved or snapshotted, capture the server scene, and avoid deleting newly uploaded client attachments before the client scene references them. Server selection with preservation disabled intentionally skips attachment validation because the client scene is discarded:

```typescript
export function resolveRecoveryConflict(
  docId: string,
  actorId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
  input: ResolveRecoveryConflictInput,
): ResolveRecoveryConflictResult {
  requireWrite(docId, actorId, role, adminMode);
  return transaction(() => {
    const current = getDocumentRaw(docId);
    if (!current) throw new HttpError(404, "Document not found");
    const serverScene = jsonToScene(current.scene);
    if (current.updated_at !== input.expectedServerUpdatedAt) {
      return {
        ok: false,
        code: "SERVER_VERSION_CHANGED",
        serverScene,
        serverUpdatedAt: current.updated_at,
      };
    }

    const mustKeepClient = input.choice === "client" || input.preserveDiscarded;
    const compactClient = mustKeepClient ? compactSceneFiles(docId, input.clientScene) : null;
    let snapshotCreated = false;
    let updatedAt = current.updated_at;

    if (input.choice === "client") {
      updatedAt = new Date(
        Math.max(Date.now(), new Date(current.updated_at).getTime() + 1),
      ).toISOString();
      getDb()
        .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
        .run(sceneToJson(compactClient!), updatedAt, docId);
      if (input.preserveDiscarded) {
        insertSnapshot(docId, serverScene, actorId, true);
        snapshotCreated = true;
      }
    } else if (input.preserveDiscarded) {
      insertSnapshot(docId, compactClient!, actorId, true, input.thumbnailBuffer);
      snapshotCreated = true;
    }

    gcUnreferencedAttachments(docId);
    return { ok: true, choice: input.choice, snapshotCreated, updatedAt };
  });
}
```

Keep `insertSnapshot()` private. Reordering the client selection to update the document before inserting the captured server snapshot is intentional: both DB writes are in one transaction, and the existing `insertSnapshot()` GC then sees both the selected client scene and preserved server scene.

- [ ] **Step 4: Run domain and attachment-retention tests**

Run:

```powershell
npm test -- tests/versions.test.ts tests/export_import.test.ts
```

Expected: both files pass; snapshot retention and attachment GC remain green.

- [ ] **Step 5: Commit the atomic domain operation**

```powershell
git add -- "src/lib/versions.ts" "tests/versions.test.ts"
git commit -m "feat(recovery): resolve draft conflicts atomically"
```

---

### Task 3: Recovery API Contract and Permission Enforcement

**Files:**
- Create: `src/app/api/documents/[id]/recovery/route.ts`
- Create: `tests/recovery.test.ts`

**Interfaces:**
- Consumes: `resolveRecoveryConflict()` from Task 2, `requireUser()`, `adminModeFrom()`, `readJson()`, `decodePngDataURL()`, and `json()`.
- Produces: `POST /api/documents/<docId>/recovery` with the exact success and `409` unions defined in the spec.

- [ ] **Step 1: Write failing route tests for owner success, viewer denial, invalid input, and `409`**

Create `tests/recovery.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { POST as postRecoveryRoute } from "@/app/api/documents/[id]/recovery/route";
import { resetConfig } from "@/lib/config";
import { resetDb, getDb } from "@/lib/db";
import { addMember, createDocument, getDocumentRaw } from "@/lib/documents";
import { SESSION_COOKIE } from "@/lib/http";
import { emptyScene, jsonToScene, sceneToJson } from "@/lib/types";
import { createSession, createUser } from "@/lib/users";
import { listVersions } from "@/lib/versions";

describe("Recovery conflict API", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  function request(docId: string, token: string, body: unknown) {
    return new Request(`http://localhost/api/documents/${docId}/recovery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("selects the client scene and reports the preserved snapshot", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const session = createSession(owner.id);
    const server = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
    const client = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
    const doc = createDocument(owner.id, server, "Conflict Doc");

    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "client",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: client,
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      choice: "client",
      snapshotCreated: true,
    });
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(client.elements);
    expect(listVersions(doc.id)).toHaveLength(1);
  });

  it("rejects a viewer without reading or mutating document recovery state", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const viewer = createUser("viewer", "pass123", "USER");
    const session = createSession(viewer.id);
    const doc = createDocument(owner.id, emptyScene(), "Conflict Doc");
    addMember(doc.id, viewer.id, "VIEWER");

    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "server",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: emptyScene(),
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );

    expect(response.status).toBe(403);
    expect(listVersions(doc.id)).toHaveLength(0);
  });

  it("returns 400 for an invalid choice or malformed envelope", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const session = createSession(owner.id);
    const doc = createDocument(owner.id, emptyScene(), "Conflict Doc");
    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "newest",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: emptyScene(),
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns the latest compact server scene on optimistic conflict", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const session = createSession(owner.id);
    const doc = createDocument(owner.id, emptyScene(), "Conflict Doc");
    const latest = { ...emptyScene(), elements: [{ id: "latest", type: "diamond" }] };
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(latest), "2099-01-01T00:00:00.000Z", doc.id);

    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "client",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] },
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      code: "SERVER_VERSION_CHANGED",
      serverScene: latest,
      serverUpdatedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(listVersions(doc.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the route test and verify the route import fails**

Run:

```powershell
npm test -- tests/recovery.test.ts
```

Expected: FAIL because `src/app/api/documents/[id]/recovery/route.ts` does not exist.

- [ ] **Step 3: Implement strict request validation and response mapping**

Create `src/app/api/documents/[id]/recovery/route.ts`:

```typescript
import { adminModeFrom, handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { decodePngDataURL } from "@/lib/thumbnails";
import type { ExcalidrawScene } from "@/lib/types";
import { resolveRecoveryConflict } from "@/lib/versions";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    if (body.choice !== "client" && body.choice !== "server") {
      return jsonError("choice must be client or server", 400);
    }
    if (
      typeof body.preserveDiscarded !== "boolean" ||
      typeof body.expectedServerUpdatedAt !== "string" ||
      typeof body.clientUpdatedAt !== "number" ||
      !Number.isFinite(body.clientUpdatedAt) ||
      !body.clientScene ||
      typeof body.clientScene !== "object" ||
      !Array.isArray((body.clientScene as { elements?: unknown }).elements)
    ) {
      return jsonError("invalid recovery request", 400);
    }

    const result = resolveRecoveryConflict(id, user.id, user.role, adminMode, {
      choice: body.choice,
      preserveDiscarded: body.preserveDiscarded,
      expectedServerUpdatedAt: body.expectedServerUpdatedAt,
      clientScene: body.clientScene as ExcalidrawScene,
      thumbnailBuffer: decodePngDataURL(body.clientThumbnailBase64),
    });
    return json(result, result.ok ? 200 : 409);
  } catch (error) {
    return handleError(error);
  }
}
```

- [ ] **Step 4: Run route and domain tests**

Run:

```powershell
npm test -- tests/recovery.test.ts tests/versions.test.ts
```

Expected: both test files pass with zero failures.

- [ ] **Step 5: Commit the endpoint**

```powershell
git add -- "src/app/api/documents/[id]/recovery/route.ts" "tests/recovery.test.ts"
git commit -m "feat(api): add draft recovery conflict endpoint"
```

---

### Task 4: Client Recovery Upload and HTTP Orchestration

**Files:**
- Modify: `src/lib/client_save.ts:141-262`
- Modify: `tests/client_save_pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 `LocalDraftEnvelope`, existing `uploadNewAttachments()`, `buildCompactClientScene()`, and `generateThumbnailDataURL()`.
- Produces:

```typescript
export interface ResolveClientRecoveryOptions {
  docId: string;
  choice: "client" | "server";
  preserveDiscarded: boolean;
  expectedServerUpdatedAt: string;
  draft: LocalDraftEnvelope;
  persistedFileIds: Set<string>;
  fetchFn?: typeof fetch;
}

export type ResolveClientRecoveryResult =
  | {
      ok: true;
      choice: "client" | "server";
      snapshotCreated: boolean;
      updatedAt: string;
    }
  | {
      ok: false;
      code: "SERVER_VERSION_CHANGED";
      serverScene: ExcalidrawScene;
      serverUpdatedAt: string;
    };

export async function resolveClientRecovery(
  options: ResolveClientRecoveryOptions,
): Promise<ResolveClientRecoveryResult>;
```

- [ ] **Step 1: Write failing transport tests for upload ordering, unchecked server choice, `409`, and failure**

Append to `tests/client_save_pipeline.test.ts`:

```typescript
// Add resolveClientRecovery to the existing import from @/lib/client_save.
it("uploads a new draft image before asking the server to snapshot the client draft", async () => {
  const calls: string[] = [];
  const dataURL = "data:image/png;base64,QQ==";
  const scene: ExcalidrawScene = {
    ...emptyScene(),
    elements: [{ id: "image", type: "image", fileId: "new-file", isDeleted: false }],
    files: { "new-file": { id: "new-file", mimeType: "image/png", dataURL, created: 1 } },
  };
  const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
    calls.push(String(url));
    if (String(url).includes("/attachments")) {
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }
    return new Response(
      JSON.stringify({ ok: true, choice: "server", snapshotCreated: true, updatedAt: "server-time" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await resolveClientRecovery({
    docId: "doc-1",
    choice: "server",
    preserveDiscarded: true,
    expectedServerUpdatedAt: "initial-time",
    draft: { scene, updatedAt: 123 },
    persistedFileIds: new Set(),
    fetchFn,
  });

  expect(calls[0]).toContain("/attachments");
  expect(calls[1]).toContain("/recovery");
});

it("does not upload discarded files when choosing server without preservation", async () => {
  const fetchFn = vi.fn(async () =>
    new Response(
      JSON.stringify({ ok: true, choice: "server", snapshotCreated: false, updatedAt: "server-time" }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
  await resolveClientRecovery({
    docId: "doc-1",
    choice: "server",
    preserveDiscarded: false,
    expectedServerUpdatedAt: "initial-time",
    draft: {
      scene: {
        ...emptyScene(),
        elements: [{ id: "image", type: "image", fileId: "new-file", isDeleted: false }],
        files: {
          "new-file": {
            id: "new-file",
            mimeType: "image/png",
            dataURL: "data:image/png;base64,QQ==",
            created: 1,
          },
        },
      },
      updatedAt: 123,
    },
    persistedFileIds: new Set(),
    fetchFn,
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(String(fetchFn.mock.calls[0][0])).toContain("/recovery");
});

it("returns a structured optimistic conflict instead of deleting client state", async () => {
  const latest = { ...emptyScene(), elements: [{ id: "latest", type: "diamond" }] };
  const fetchFn = vi.fn(async () =>
    new Response(
      JSON.stringify({
        ok: false,
        code: "SERVER_VERSION_CHANGED",
        serverScene: latest,
        serverUpdatedAt: "latest-time",
      }),
      { status: 409 },
    ),
  ) as unknown as typeof fetch;
  await expect(
    resolveClientRecovery({
      docId: "doc-1",
      choice: "client",
      preserveDiscarded: false,
      expectedServerUpdatedAt: "initial-time",
      draft: { scene: emptyScene(), updatedAt: 123 },
      persistedFileIds: new Set(),
      fetchFn,
    }),
  ).resolves.toEqual({
    ok: false,
    code: "SERVER_VERSION_CHANGED",
    serverScene: latest,
    serverUpdatedAt: "latest-time",
  });
});

it("throws the server error when recovery fails", async () => {
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify({ error: "snapshot failed" }), { status: 500 }),
  ) as unknown as typeof fetch;
  await expect(
    resolveClientRecovery({
      docId: "doc-1",
      choice: "server",
      preserveDiscarded: false,
      expectedServerUpdatedAt: "initial-time",
      draft: { scene: emptyScene(), updatedAt: 123 },
      persistedFileIds: new Set(),
      fetchFn,
    }),
  ).rejects.toThrow("snapshot failed");
});
```

- [ ] **Step 2: Run the targeted client test and verify the new function is missing**

Run:

```powershell
npm test -- tests/client_save_pipeline.test.ts
```

Expected: FAIL because `resolveClientRecovery` is not exported.

- [ ] **Step 3: Implement conditional upload and structured response handling**

Add `resolveClientRecovery()` to `src/lib/client_save.ts`:

```typescript
export async function resolveClientRecovery(
  options: ResolveClientRecoveryOptions,
): Promise<ResolveClientRecoveryResult> {
  const fetchImpl = options.fetchFn || window.fetch.bind(window);
  const mustKeepClient = options.choice === "client" || options.preserveDiscarded;
  if (mustKeepClient) {
    await uploadNewAttachments(options.docId, options.draft.scene, options.persistedFileIds, {
      fetchFn: fetchImpl,
    });
  }
  const compactScene = buildCompactClientScene(options.draft.scene);
  const clientThumbnailBase64 =
    options.choice === "server" && options.preserveDiscarded
      ? await generateThumbnailDataURL(options.draft.scene)
      : null;
  const response = await fetchImpl(
    `/api/documents/${encodeURIComponent(options.docId)}/recovery`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choice: options.choice,
        preserveDiscarded: options.preserveDiscarded,
        expectedServerUpdatedAt: options.expectedServerUpdatedAt,
        clientScene: compactScene,
        clientUpdatedAt: options.draft.updatedAt,
        ...(clientThumbnailBase64 ? { clientThumbnailBase64 } : {}),
      }),
    },
  );
  const data = (await response.json()) as ResolveClientRecoveryResult & { error?: string };
  if (response.status === 409 && !data.ok && data.code === "SERVER_VERSION_CHANGED") {
    return data;
  }
  if (!response.ok) throw new Error(data.error || `Recovery failed with HTTP ${response.status}`);
  return data;
}
```

Use the same absolute URL construction already used by `saveDocumentScene()` if Node tests require it; do not add a second URL helper.

- [ ] **Step 4: Run the client pipeline tests**

Run:

```powershell
npm test -- tests/client_save_pipeline.test.ts
```

Expected: the complete client pipeline test file passes.

- [ ] **Step 5: Commit the client recovery transport**

```powershell
git add -- "src/lib/client_save.ts" "tests/client_save_pipeline.test.ts"
git commit -m "feat(client): orchestrate recovery uploads and requests"
```

---

### Task 5: Blocking Recovery Conflict Modal

**Files:**
- Create: `src/components/RecoveryConflictModal.tsx`
- Create: `tests/recovery_modal.test.ts`

**Interfaces:**
- Consumes: Task 1 `RecoverySceneSummary`.
- Produces:

```typescript
interface RecoveryConflictModalProps {
  client: RecoverySceneSummary;
  server: RecoverySceneSummary;
  preserveDiscarded: boolean;
  busy: boolean;
  error: string | null;
  onPreserveChange(value: boolean): void;
  onChoose(choice: "client" | "server"): void;
}
```

- [ ] **Step 1: Write a failing static-render test for required controls and accessibility**

Create `tests/recovery_modal.test.ts`:

```typescript
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RecoveryConflictModal from "@/components/RecoveryConflictModal";

describe("RecoveryConflictModal", () => {
  it("renders a blocking dialog with both choices and preservation enabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryConflictModal, {
        client: { updatedAt: 100, elementCount: 2, imageCount: 1 },
        server: { updatedAt: "2026-08-31T00:00:00.000Z", elementCount: 3, imageCount: 0 },
        preserveDiscarded: true,
        busy: false,
        error: null,
        onPreserveChange: vi.fn(),
        onChoose: vi.fn(),
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Client draft");
    expect(html).toContain("Server version");
    expect(html).toContain("Use client draft");
    expect(html).toContain("Use server version");
    expect(html).toContain("Preserve the version not selected as a recovery snapshot");
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Close");
  });

  it("keeps both choices visible while showing a retryable error", () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryConflictModal, {
        client: { updatedAt: 100, elementCount: 2, imageCount: 1 },
        server: { updatedAt: 200, elementCount: 3, imageCount: 0 },
        preserveDiscarded: true,
        busy: false,
        error: "snapshot failed",
        onPreserveChange: vi.fn(),
        onChoose: vi.fn(),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("snapshot failed");
    expect(html).toContain("Use client draft");
    expect(html).toContain("Use server version");
  });
});
```

- [ ] **Step 2: Run the modal test and verify the component import fails**

Run:

```powershell
npm test -- tests/recovery_modal.test.ts
```

Expected: FAIL because `RecoveryConflictModal.tsx` does not exist.

- [ ] **Step 3: Implement the controlled modal with no dismissal path**

Create `src/components/RecoveryConflictModal.tsx` with this controlled structure:

```tsx
"use client";

import type { RecoverySceneSummary } from "@/lib/client_save";

interface RecoveryConflictModalProps {
  client: RecoverySceneSummary;
  server: RecoverySceneSummary;
  preserveDiscarded: boolean;
  busy: boolean;
  error: string | null;
  onPreserveChange(value: boolean): void;
  onChoose(choice: "client" | "server"): void;
}

function formatTime(value: number | string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export default function RecoveryConflictModal(props: RecoveryConflictModalProps) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-conflict-title"
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl"
      >
        <h2 id="recovery-conflict-title" className="text-lg font-semibold">
          Unsaved changes conflict
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Choose which version to use. Times are shown for context only.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(["client", "server"] as const).map((kind) => {
            const item = props[kind];
            return (
              <div key={kind} className="rounded border p-3 text-sm">
                <h3 className="font-medium">{kind === "client" ? "Client draft" : "Server version"}</h3>
                <p>Updated: {formatTime(item.updatedAt)}</p>
                <p>Elements: {item.elementCount}</p>
                <p>Images: {item.imageCount}</p>
              </div>
            );
          })}
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={props.preserveDiscarded}
            disabled={props.busy}
            onChange={(event) => props.onPreserveChange(event.target.checked)}
          />
          Preserve the version not selected as a recovery snapshot
        </label>
        {props.error && <p role="alert" className="mt-3 text-sm text-red-700">{props.error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={props.busy} onClick={() => props.onChoose("server")}>
            Use server version
          </button>
          <button type="button" disabled={props.busy} onClick={() => props.onChoose("client")}>
            Use client draft
          </button>
        </div>
      </section>
    </div>
  );
}
```

Keep the existing Tailwind style conventions when refining the classes. Do not accept `onClose`, attach a backdrop click handler, or register an Escape handler.

- [ ] **Step 4: Run modal test and typecheck**

Run:

```powershell
npm test -- tests/recovery_modal.test.ts
npm run typecheck
```

Expected: modal test passes and TypeScript reports zero errors.

- [ ] **Step 5: Commit the modal**

```powershell
git add -- "src/components/RecoveryConflictModal.tsx" "tests/recovery_modal.test.ts"
git commit -m "feat(editor): add blocking recovery conflict dialog"
```

---

### Task 6: Editor Load Gate, Resolution Flow, and Draft Lifecycle Corrections

**Files:**
- Modify: `src/app/documents/[id]/EditorClient.tsx:1-355, 639-650`
- Modify: `tests/client_save_pipeline.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, and 5 exports: `decideDraftForAccess()`, `localDraftStorageKey()`, `summarizeRecoveryScene()`, `resolveClientRecovery()`, and `RecoveryConflictModal`.
- Produces: editor load state that never mounts an editable canvas before the draft decision is complete.

- [ ] **Step 1: Add a failing regression test for the clean-state transition contract**

The integration will use one small helper from `client_save.ts` so the stale-draft cleanup condition remains executable without a DOM:

```typescript
export function sceneMatchesLastSaved(
  scene: ExcalidrawScene,
  lastSavedSerialized: string,
): boolean {
  return serializeSceneForComparison(scene) === lastSavedSerialized;
}
```

First add `sceneMatchesLastSaved` to the existing test import from `@/lib/client_save`, then add this failing test to `tests/client_save_pipeline.test.ts`:

```typescript
it("recognizes undo back to the last saved scene as clean", () => {
  const saved = { ...emptyScene(), elements: [{ id: "saved", type: "rectangle" }] };
  expect(sceneMatchesLastSaved(saved, serializeSceneForComparison(saved))).toBe(true);
});
```

- [ ] **Step 2: Run the targeted test and verify the helper is missing**

Run:

```powershell
npm test -- tests/client_save_pipeline.test.ts
```

Expected: FAIL because `sceneMatchesLastSaved` is not exported.

- [ ] **Step 3: Add editor recovery state and viewer bypass before localStorage access**

Implement the helper before editing the component:

```typescript
export function sceneMatchesLastSaved(
  scene: ExcalidrawScene,
  lastSavedSerialized: string,
): boolean {
  return serializeSceneForComparison(scene) === lastSavedSerialized;
}
```

Add imports for the Task 1 and Task 4 helpers and `RecoveryConflictModal`. Use `decideDraftForAccess()` from Task 1 so the viewer storage bypass is covered by the executable helper test. Add this local state shape near the existing scene refs:

```typescript
interface DraftConflictState {
  draft: LocalDraftEnvelope;
  serverScene: ExcalidrawScene;
  serverUpdatedAt: string;
}

const draftKey = localDraftStorageKey(user.id, docId);
const [recoveryReady, setRecoveryReady] = useState(!canEdit);
const [draftConflict, setDraftConflict] = useState<DraftConflictState | null>(null);
const [preserveDiscarded, setPreserveDiscarded] = useState(true);
const [recoveryBusy, setRecoveryBusy] = useState(false);
const [recoveryError, setRecoveryError] = useState<string | null>(null);
```

Replace the current timestamp-winner restore effect with this ordering:

```typescript
useEffect(() => {
  const decision = decideDraftForAccess(
    canEdit,
    () => localStorage.getItem(draftKey),
    initialScene,
  );
  if (!canEdit) {
    setRecoveryReady(true);
    return;
  }
  if (decision.kind === "equal") {
    localStorage.removeItem(draftKey);
    setRecoveryReady(true);
  } else if (decision.kind === "conflict") {
    setDraftConflict({
      draft: decision.draft,
      serverScene: initialScene,
      serverUpdatedAt: initialUpdatedAt || "",
    });
  } else {
    if (decision.kind === "malformed") {
      setStatus("Local recovery draft could not be read; server version opened and draft retained.", "error");
    }
    setRecoveryReady(true);
  }
}, [canEdit, draftKey, initialScene, initialUpdatedAt, setStatus]);
```

Pass `localStorage.getItem()` only as the lazy callback shown above; `decideDraftForAccess(false, ...)` must return without invoking it. Do not read the legacy document-only key.

- [ ] **Step 4: Implement retryable choice handling**

Add a `resolveDraftChoice()` callback:

```typescript
const resolveDraftChoice = useCallback(
  async (choice: "client" | "server") => {
    if (!draftConflict || recoveryBusy) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      const result = await resolveClientRecovery({
        docId,
        choice,
        preserveDiscarded,
        expectedServerUpdatedAt: draftConflict.serverUpdatedAt,
        draft: draftConflict.draft,
        persistedFileIds: persistedFileIdsRef.current,
      });
      if (!result.ok) {
        setDraftConflict((current) =>
          current
            ? {
                ...current,
                serverScene: result.serverScene,
                serverUpdatedAt: result.serverUpdatedAt,
              }
            : current,
        );
        setRecoveryError("The server version changed. Compare the latest server version and choose again.");
        return;
      }

      const selected = choice === "client" ? draftConflict.draft.scene : draftConflict.serverScene;
      localStorage.removeItem(draftKey);
      sceneRef.current = selected;
      lastSavedContentRef.current = serializeSceneForComparison(selected);
      isDirtyRef.current = false;
      setInitialCanvasScene(selected);
      setCanvasKey((key) => key + 1);
      setDraftConflict(null);
      setRecoveryReady(true);
      if (result.snapshotCreated) await loadVersions();
      setStatus(choice === "client" ? "Client draft restored" : "Server version selected", "saved");
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "Recovery failed");
    } finally {
      setRecoveryBusy(false);
    }
  }, [draftConflict, recoveryBusy, docId, draftKey, preserveDiscarded, loadVersions, setStatus],
);
```

Do not remove the draft in any error or `409` branch.

- [ ] **Step 5: Use the scoped key everywhere and fix edit-to-undo cleanup**

Replace every `excalidraw_draft_${docId}` read, write, and removal with `draftKey`.

In `handleChange()`, replace the current clean early return with:

```typescript
if (sceneMatchesLastSaved(s, lastSavedContentRef.current)) {
  isDirtyRef.current = false;
  if (debounceRef.current) {
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Browser storage may be unavailable; the scene is still clean in memory.
  }
  return;
}
```

Write the Task 1 `LocalDraftEnvelope` to the scoped key. In the `localStorage.setItem()` catch, call:

```typescript
setStatus("Local recovery draft could not be saved; keep this tab open until server save completes.", "error");
```

Add `draftKey` and `setStatus` to the callback dependencies.

- [ ] **Step 6: Gate canvas mounting and render the blocking modal**

Replace the unconditional canvas render with:

```tsx
{recoveryReady && !draftConflict ? (
  <ExcalidrawCanvas
    key={`canvas-${docId}-${canvasKey}`}
    docId={docId}
    initialScene={initialCanvasScene}
    readOnly={!canEdit}
    onSceneChange={handleChange}
    theme={theme}
  />
) : (
  <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">
    Checking for unsaved changes…
  </div>
)}
```

Render `RecoveryConflictModal` as a sibling of `<main>` only when `draftConflict` exists. Pass summaries from `summarizeRecoveryScene()`, controlled checkbox state, `recoveryBusy`, `recoveryError`, and `onChoose={(choice) => void resolveDraftChoice(choice)}`.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```powershell
npm test -- tests/client_save_pipeline.test.ts tests/recovery_modal.test.ts tests/recovery.test.ts tests/versions.test.ts
npm run typecheck
```

Expected: all four test files pass and TypeScript reports zero errors.

- [ ] **Step 8: Commit the editor integration**

```powershell
git add -- "src/app/documents/[id]/EditorClient.tsx" "src/lib/client_save.ts" "tests/client_save_pipeline.test.ts"
git commit -m "feat(editor): gate loading on draft conflict resolution"
```

---

### Task 7: Documentation, Full Regression, and Manual Browser Acceptance

**Files:**
- Modify: `docs/ATTACHMENT_FILE_TRANSFER_STATUS.md:64-end`
- Modify: `docs/CHECKLIST.md:140-end`
- Modify: `docs/superpowers/specs/2026-08-31-local-draft-recovery-conflict-design.md:1-4`
- Verify: all source and test files from Tasks 1-6

**Interfaces:**
- Consumes: completed recovery flow and test evidence from Tasks 1-6.
- Produces: documented completion state and reproducible acceptance checklist.

- [ ] **Step 1: Run the complete automated test suite**

Run:

```powershell
npm test
```

Expected: every Vitest file passes with zero failed tests.

- [ ] **Step 2: Run TypeScript verification**

Run:

```powershell
npm run typecheck
```

Expected: `tsc --noEmit` exits with zero errors. Do not run the production build.

- [ ] **Step 3: Perform writable-user browser checks**

Start the existing development server only if one is not already running:

```powershell
npm run dev
```

Verify these exact cases in a browser:

1. Edit a document, interrupt the network before auto-save, refresh, and confirm the blocking dialog appears.
2. Confirm preservation is checked by default.
3. Choose client; confirm the prior server scene appears in History and the client scene becomes current.
4. Create another mismatch, choose server; confirm the client scene appears in History and the server scene remains current.
5. Repeat both choices with preservation unchecked; confirm History does not gain a conflict snapshot.
6. Delete every element, interrupt save, refresh, choose the empty client draft, and confirm the empty scene persists.
7. Force the recovery endpoint to fail or go offline; confirm the dialog and local draft remain and retry succeeds.
8. Use a client draft with a new image; confirm attachment upload precedes recovery, the image survives refresh, and no `/documents/undefined` request occurs.

- [ ] **Step 4: Perform permission and account-isolation browser checks**

1. Create a user-scoped draft as an editor.
2. Change that member to `VIEWER`, reload, and confirm only the server scene appears with no dialog and no localStorage mutation.
3. Restore edit permission, reload, and confirm the preserved draft produces the dialog.
4. Sign in as a different authorized editor in the same browser profile and confirm the first user's draft is neither read nor displayed.
5. Place malformed JSON in the current user's scoped key, reload, and confirm the server scene opens with a warning while the malformed value remains.

- [ ] **Step 5: Record verified behavior in existing documentation**

In `docs/ATTACHMENT_FILE_TRANSFER_STATUS.md`, add a resolved-status table beneath the audit findings with each prior finding mapped to its implemented correction and test file.

In `docs/CHECKLIST.md`, add checked scenarios for:

```markdown
- [x] Load-time local/server mismatch requires an explicit writable-user choice.
- [x] The unselected version is snapshotted by default for both client and server choices.
- [x] VIEWER always sees server state without local draft access or deletion.
- [x] Empty-scene recovery, edit-to-undo cleanup, account isolation, and image recovery are covered.
```

Change the design document status to:

```markdown
**Status:** Implemented and verified
```

Only mark browser scenarios checked after completing Steps 3 and 4.

- [ ] **Step 6: Check the final diff for accidental scope expansion**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD~6..HEAD
```

Expected: no whitespace errors; changes are limited to the files listed in this plan; no dependency or lockfile changes.

- [ ] **Step 7: Commit verification documentation**

```powershell
git add -- "docs/ATTACHMENT_FILE_TRANSFER_STATUS.md" "docs/CHECKLIST.md" "docs/superpowers/specs/2026-08-31-local-draft-recovery-conflict-design.md"
git commit -m "docs: verify local draft conflict recovery"
```

---

## Acceptance Summary

- Every writable-user normalized mismatch blocks canvas editing until an explicit choice succeeds.
- The preservation checkbox defaults on and snapshots exactly the unselected version.
- Client selection persists immediately; server selection never changes the current document.
- Any upload, snapshot, save, authorization, or concurrency failure retains the local draft and dialog.
- A `409` refreshes the server candidate and requires a new explicit choice without mutation.
- `VIEWER` never reads localStorage and always sees the server scene.
- Empty drafts, hydration-only files, edit-to-undo, malformed data, legacy keys, account switching, snapshot retention, and attachment GC follow the approved design.
- No build, new package, schema migration, live-collaboration conflict handling, or visual preview is included.
