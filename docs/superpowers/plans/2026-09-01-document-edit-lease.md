# Document-Scoped Single-Editor Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow exactly one active canvas editor per document, with read-only fallback, graceful/forced takeover, and atomic stale-write rejection.

**Architecture:** A SQLite lease row is the server authority. The active browser heartbeats over ordinary HTTP; takeover uses bounded one-second polling for at most ten seconds. Every scene/history mutation validates token and generation in the same immediate transaction as the write, while the client acquires the lease before local draft recovery or editable canvas mount.

**Tech Stack:** Next.js 15 route handlers, React 18, TypeScript, built-in `node:sqlite`, Vitest, existing Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-09-01-document-edit-lease-design.md`

## Global Constraints

- Work on branch `feat/document-edit-lease`; create it from the current checked-out commit while preserving the documentation changes already present in the assigned worktree.
- Do not create another worktree or edit the same worktree from another Worker.
- Heartbeat is exactly 2 seconds; lease expiry is 90 seconds; takeover polling is 1 second; forced takeover deadline is 10 seconds.
- VIEWER and deleted-document views never access localStorage and never participate in leases.
- Fence auto-save, manual save, local draft recovery resolution, and history restore.
- Do not fence title rename, sharing/permission changes, attachment upload, import, Trash actions, or restore from Trash.
- Do not add packages, WebSockets, SSE, long-polling, Redis, CRDT abstractions, or a takeover queue.
- Do not run browser E2E or a production build. The user will perform browser acceptance.
- Use the repository's existing package manager/runtime; do not install anything globally.
- Preserve unrelated user changes. Commit only reviewed files belonging to this feature.

---

### Task 0: Branch and Documentation Baseline

**Files:**
- Existing uncommitted docs: `docs/SELF_HOSTED_COLLABORATION_RESEARCH.md`
- Existing uncommitted docs: `docs/implement_plan.md`
- Existing uncommitted spec: `docs/superpowers/specs/2026-09-01-document-edit-lease-design.md`
- Existing uncommitted plan: `docs/superpowers/plans/2026-09-01-document-edit-lease.md`

**Interfaces:**
- Consumes: current clean runtime code at commit `078659a` plus Senior-authored documentation changes.
- Produces: branch `feat/document-edit-lease` with the documentation baseline committed before runtime implementation.

- [ ] **Step 1: Inspect the starting state without discarding changes**

```powershell
git branch --show-current
git status --short
git diff --check
```

Expected: current branch is `main`; only the four documented files above are modified/untracked. If other files appear, stop and report them to the Senior instead of resetting or overwriting them.

- [ ] **Step 2: Create the feature branch in the assigned worktree**

```powershell
git switch -c feat/document-edit-lease
```

Expected: checkout succeeds and all documentation changes remain present.

- [ ] **Step 3: Review and commit the documentation baseline**

```powershell
git diff --check
git add -- "docs/SELF_HOSTED_COLLABORATION_RESEARCH.md" "docs/implement_plan.md" "docs/superpowers/specs/2026-09-01-document-edit-lease-design.md" "docs/superpowers/plans/2026-09-01-document-edit-lease.md"
git commit -m "docs: design document editor lease"
```

Expected: one documentation-only commit on the feature branch.

---

### Task 1: SQLite Lease State Machine

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/lib/types.ts`
- Create: `src/lib/edit_lease.ts`
- Create: `tests/edit_lease.test.ts`

**Interfaces:**
- Consumes: `transaction()`, `requireWrite()`, `HttpError`, user/document rows.
- Produces:

```typescript
export interface EditLeaseCredentials {
  clientId: string;
  leaseToken: string;
  generation: number;
}

export const LEASE_HEARTBEAT_MS = 2_000;
export const LEASE_TTL_MS = 90_000;
export const TAKEOVER_POLL_MS = 1_000;
export const TAKEOVER_TIMEOUT_MS = 10_000;

export function acquireEditLease(input: LeaseIdentityInput, now?: Date): LeaseResult;
export function heartbeatEditLease(input: ActiveLeaseInput, now?: Date): LeaseResult;
export function requestEditTakeover(input: TakeoverInput, now?: Date): LeaseResult;
export function pollEditTakeover(input: PollTakeoverInput, now?: Date): LeaseResult;
export function releaseEditLease(input: ActiveLeaseInput, now?: Date): LeaseResult;
export function assertActiveEditLease(input: ActiveLeaseInput, now?: Date): void;
```

Every state-changing function accepts an optional test clock such as `now?: Date`, but production callers omit it.

- [ ] **Step 1: Write failing state-machine tests**

Create `tests/edit_lease.test.ts` using the existing `resetDb()`, user, and document factories. Cover these executable cases:

```typescript
it("acquires idempotently only for the same complete credentials", () => {
  const first = acquireEditLease(identity({ leaseToken: "token-a" }), NOW);
  const retry = acquireEditLease(identity({ leaseToken: "token-a" }), NOW);
  expect(retry).toMatchObject({ state: "acquired", generation: first.generation });
  const held = acquireEditLease(identity({ leaseToken: "token-b" }), NOW);
  expect(held).toMatchObject({ state: "held" });
  expect(JSON.stringify(held)).not.toContain("token-a");
});

it("advances generation and rejects the old holder after forced takeover", () => {
  const held = acquireEditLease(holderInput, NOW);
  const pending = requestEditTakeover(requesterInput, NOW);
  const acquired = pollEditTakeover(
    { ...requesterInput, requestId: pending.requestId },
    new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS),
  );
  expect(acquired.generation).toBe(held.generation + 1);
  expect(() => assertActiveEditLease({ ...holderInput, generation: held.generation }, new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS))).toThrowError(/lost/i);
});
```

Also test heartbeat renewal, direct acquisition of an expired row, graceful transfer on release, VIEWER denial, deleted-document denial, first-pending-request wins, idempotent retry by the same request ID, and holder summaries containing no tokens/client IDs.

- [ ] **Step 2: Run the state-machine test and verify it fails**

```powershell
npm test -- tests/edit_lease.test.ts
```

Expected: FAIL because the lease module and schema do not exist.

- [ ] **Step 3: Add shared types and schema**

Add the spec's `document_edit_leases` table to `SCHEMA_SQL`. In `resetDb()`, delete lease rows before deleting documents/users.

Add only wire-safe shared types to `src/lib/types.ts`; keep SQLite row and server input types inside `edit_lease.ts`.

- [ ] **Step 4: Implement the minimal transactional state machine**

Use one-row SQL operations inside `transaction()`. Server time controls all comparisons. Generate/advance `generation` only on acquisition or transfer. An ordinary release clears nullable holder/pending fields but retains the row and generation. Clear every pending takeover column in the same statement that transfers ownership.

The validation core must compare all authority fields:

```typescript
if (
  row.holder_user_id !== input.userId ||
  row.holder_client_id !== input.clientId ||
  row.lease_token !== input.leaseToken ||
  row.generation !== input.generation ||
  Date.parse(row.expires_at) <= now.getTime()
) {
  throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
}
```

Do not return raw rows. Map them to explicit result objects that expose only the current caller's credentials and safe holder metadata. `held` and `takeover_in_progress` are normal results; only invalid authority such as a stale heartbeat/mutation throws `EDIT_LEASE_LOST`.

- [ ] **Step 5: Run state-machine and database regression tests**

```powershell
npm test -- tests/edit_lease.test.ts tests/documents.test.ts
npm run typecheck
```

Expected: all targeted tests pass and TypeScript reports zero errors.

- [ ] **Step 6: Commit the server state machine**

```powershell
git add -- "src/lib/db.ts" "src/lib/types.ts" "src/lib/edit_lease.ts" "tests/edit_lease.test.ts"
git commit -m "feat(lease): add document edit lease state machine"
```

---

### Task 2: Lease API and Structured Errors

**Files:**
- Modify: `src/lib/http.ts`
- Create: `src/app/api/documents/[id]/lease/route.ts`
- Create: `tests/edit_lease_route.test.ts`

**Interfaces:**
- Consumes: Task 1 lease functions and shared wire types.
- Produces: `POST /api/documents/[id]/lease` action dispatcher and machine-readable HTTP errors.

- [ ] **Step 1: Write failing route tests**

Follow the existing authenticated route-test request pattern. Verify:

```typescript
expect((await acquireResponse.json()).state).toBe("acquired");
expect(heldResponse.status).toBe(409);
const heldBody = await heldResponse.json();
expect(heldBody).toMatchObject({ code: "EDIT_LEASE_HELD" });
expect(JSON.stringify(heldBody)).not.toContain("leaseToken");
```

Test all five actions, malformed/missing action fields (`400`), unauthenticated access (`401`), VIEWER (`403`), and lost credentials (`409 EDIT_LEASE_LOST`).

- [ ] **Step 2: Run the route test and verify it fails**

```powershell
npm test -- tests/edit_lease_route.test.ts
```

Expected: FAIL because the route does not exist and `HttpError` has no stable code.

- [ ] **Step 3: Extend `HttpError` without breaking existing callers**

Use an optional third constructor argument:

```typescript
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
```

`handleError()` must include `{ error, code }` only when a code exists. Existing message-only responses remain compatible.

- [ ] **Step 4: Implement the action route with trust-boundary validation**

Accept only the five spec actions. Require non-empty bounded strings for client ID, lease token, and request ID; require a positive safe integer for generation. Do not accept timestamps from clients.

Dispatch to Task 1 functions and return their explicit result. Map `held` and `takeover_in_progress` to their stable `409` codes while retaining safe holder/progress metadata. Do not duplicate lease SQL or permission logic in the route.

- [ ] **Step 5: Run API and authentication regressions**

```powershell
npm test -- tests/edit_lease_route.test.ts tests/auth.test.ts tests/documents.test.ts
npm run typecheck
```

Expected: all targeted tests pass.

- [ ] **Step 6: Commit the API**

```powershell
git add -- "src/lib/http.ts" "src/app/api/documents/[id]/lease/route.ts" "tests/edit_lease_route.test.ts"
git commit -m "feat(lease): expose document lease API"
```

---

### Task 3: Atomically Fence Every Scene and History Mutation

**Files:**
- Modify: `src/lib/versions.ts`
- Modify: `src/app/api/documents/[id]/scene/route.ts`
- Modify: `src/app/api/documents/[id]/save/route.ts`
- Modify: `src/app/api/documents/[id]/recovery/route.ts`
- Modify: `src/app/api/documents/[id]/versions/route.ts`
- Modify: `tests/versions.test.ts`
- Modify: `tests/version_origin.test.ts`
- Modify: `tests/recovery.test.ts`
- Create: `tests/edit_lease_fencing.test.ts`

**Interfaces:**
- Consumes: `EditLeaseCredentials` and `assertActiveEditLease()`.
- Produces lease-aware signatures:

```typescript
export function handleAutoSave(
  docId: string,
  actorId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
  scene: ExcalidrawScene,
  thumbnailBuffer: Buffer | null,
  snapshotRequested: boolean,
  lease: EditLeaseCredentials,
): { snapshotCreated: boolean; updatedAt: string };

// Add `lease: EditLeaseCredentials` to handleManualSave,
// resolveRecoveryConflict, and restoreVersion.
```

- [ ] **Step 1: Write failing fencing tests**

For each of auto-save, manual save, recovery, and restore:

1. acquire generation N;
2. request and force takeover to generation N+1;
3. call the mutation with generation N;
4. expect `EDIT_LEASE_LOST`;
5. assert both `documents.scene` and `document_versions` count are unchanged.

Include one success case using generation N+1.

- [ ] **Step 2: Run fencing tests and verify stale calls currently mutate or lack credentials**

```powershell
npm test -- tests/edit_lease_fencing.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 3: Consolidate auto-save into one transaction**

Move the route's update plus conditional auto-snapshot decision behind `handleAutoSave()`. Its transaction order is:

```typescript
return transaction(() => {
  requireWrite(docId, actorId, role, adminMode);
  assertActiveEditLease({ docId, userId: actorId, role, adminMode, ...lease });
  const updated = updateScene(docId, scene, actorId, role, adminMode, { thumbnailBuffer });
  const snapshotCreated = snapshotRequested && snapshotDueForAutoSave(docId, AUTO_INTERVAL);
  if (snapshotCreated) {
    createSnapshotFromScene(docId, scene, actorId, true, thumbnailBuffer, { origin: "auto_snapshot" });
  }
  return { snapshotCreated, updatedAt: updated.updated_at };
});
```

Do not validate outside this transaction and then write later.

- [ ] **Step 4: Fence manual save, recovery, and restore inside their existing transactions**

Move `requireWrite()` into each transaction if necessary and immediately follow it with `assertActiveEditLease()`. No document or snapshot write may happen first.

Parse `body.lease` in every route and return `400` for malformed credentials. Pass the complete credentials into the domain function.

- [ ] **Step 5: Update existing domain tests with real acquired leases**

Add a small test helper that acquires a lease for the test user/document and returns credentials. Do not add a production bypass or optional lease argument merely to keep old tests short.

- [ ] **Step 6: Run all mutation and origin tests**

```powershell
npm test -- tests/edit_lease_fencing.test.ts tests/versions.test.ts tests/version_origin.test.ts tests/recovery.test.ts tests/documents.test.ts tests/export_import.test.ts
npm run typecheck
```

Expected: all targeted tests pass; pre-restore snapshot behavior and origin labels remain unchanged.

- [ ] **Step 7: Commit mutation fencing**

```powershell
git add -- "src/lib/versions.ts" "src/app/api/documents/[id]/scene/route.ts" "src/app/api/documents/[id]/save/route.ts" "src/app/api/documents/[id]/recovery/route.ts" "src/app/api/documents/[id]/versions/route.ts" "tests/edit_lease_fencing.test.ts" "tests/versions.test.ts" "tests/version_origin.test.ts" "tests/recovery.test.ts"
git commit -m "feat(lease): fence document scene mutations"
```

---

### Task 4: Client Lease Transport and Save Credentials

**Files:**
- Modify: `src/lib/client.ts`
- Create: `src/lib/client_edit_lease.ts`
- Modify: `src/lib/client_save.ts`
- Modify: `tests/client_save_pipeline.test.ts`
- Create: `tests/client_edit_lease.test.ts`

**Interfaces:**
- Consumes: Task 1 shared lease types and Task 2 error codes.
- Produces:

```typescript
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export function getLeaseClientId(storage: Storage): string;
export function acquireLease(docId: string, identity: LeaseCandidate, fetchFn?: typeof fetch): Promise<LeaseResponse>;
export function heartbeatLease(docId: string, lease: EditLeaseCredentials, fetchFn?: typeof fetch): Promise<LeaseResponse>;
export function requestTakeover(docId: string, candidate: LeaseCandidate, fetchFn?: typeof fetch): Promise<LeaseResponse>;
export function pollTakeover(docId: string, request: TakeoverPoll, fetchFn?: typeof fetch): Promise<LeaseResponse>;
export function releaseLease(docId: string, lease: EditLeaseCredentials, fetchFn?: typeof fetch): Promise<LeaseResponse>;
```

- [ ] **Step 1: Write failing transport tests**

Verify client ID creation/reuse in a provided fake Storage, stable `ApiError` status/code parsing, credentials in every lease action, and credentials in scene/manual/recovery payloads.

```typescript
expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
  lease: { clientId: "client-a", leaseToken: "token-a", generation: 3 },
});
```

- [ ] **Step 2: Run client tests and verify missing interfaces**

```powershell
npm test -- tests/client_edit_lease.test.ts tests/client_save_pipeline.test.ts
```

Expected: FAIL before the client module and credential fields exist.

- [ ] **Step 3: Add structured client API errors**

Change `api()` and `apiForm()` to throw `ApiError` while keeping their existing error message behavior. Direct fetch helpers must use the same response parsing rule rather than checking error strings.

- [ ] **Step 4: Implement the thin lease transport module**

Use `sessionStorage` only for `clientId`. Generate candidate lease tokens and takeover request IDs with `crypto.randomUUID()` in the calling editor instance; do not store active lease tokens in localStorage or expose them in messages/logs.

Keep transport functions stateless. They send one HTTP request and return a typed response; timers and UI state belong to `EditorClient`.

- [ ] **Step 5: Add lease credentials to save and recovery pipelines**

Make `lease` required in `SaveDocumentOptions` and `ResolveClientRecoveryOptions`. Include it in JSON payloads after attachment upload. If the final fenced request fails, leave `persistedFileIds` updated for successful uploads but let the caller preserve its draft.

- [ ] **Step 6: Run client pipeline tests and typecheck**

```powershell
npm test -- tests/client_edit_lease.test.ts tests/client_save_pipeline.test.ts
npm run typecheck
```

Expected: all targeted tests pass.

- [ ] **Step 7: Commit client transport**

```powershell
git add -- "src/lib/client.ts" "src/lib/client_edit_lease.ts" "src/lib/client_save.ts" "tests/client_edit_lease.test.ts" "tests/client_save_pipeline.test.ts"
git commit -m "feat(lease): add client lease transport"
```

---

### Task 5: Accessible Lease Conflict UI

**Files:**
- Create: `src/components/EditLeaseConflictModal.tsx`
- Create: `tests/edit_lease_modal.test.ts`

**Interfaces:**
- Consumes: safe `LeaseHolderSummary`.
- Produces:

```typescript
interface EditLeaseConflictModalProps {
  holder: LeaseHolderSummary;
  busy: boolean;
  error: string | null;
  onReadOnly(): void;
  onTakeover(): void;
}
```

- [ ] **Step 1: Write a failing static-render accessibility test**

```typescript
expect(html).toContain('role="dialog"');
expect(html).toContain('aria-modal="true"');
expect(html).toContain("already being edited");
expect(html).toContain("Open read-only");
expect(html).toContain("Take over editing");
expect(html).not.toContain("leaseToken");
```

Also verify busy controls are disabled and a retryable error uses `role="alert"`.

- [ ] **Step 2: Run the modal test and verify the component is missing**

```powershell
npm test -- tests/edit_lease_modal.test.ts
```

- [ ] **Step 3: Implement the blocking modal**

Follow the existing `RecoveryConflictModal` visual conventions. Do not provide Escape, backdrop, or close-button dismissal. Use distinct secondary `Open read-only` and destructive/attention `Take over editing` actions with visible hover, focus, disabled, and busy states.

- [ ] **Step 4: Run modal tests and typecheck**

```powershell
npm test -- tests/edit_lease_modal.test.ts tests/recovery_modal.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit the UI component**

```powershell
git add -- "src/components/EditLeaseConflictModal.tsx" "tests/edit_lease_modal.test.ts"
git commit -m "feat(lease): add edit conflict prompt"
```

---

### Task 6: Editor Load Gate, Heartbeat, Takeover, and Lease-Loss Recovery

**Files:**
- Modify: `src/app/documents/[id]/EditorClient.tsx`
- Modify: `tests/client_edit_lease.test.ts`
- Modify: `tests/client_save_pipeline.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5 transport/UI plus existing local draft recovery.
- Produces: the spec's `EditorLeaseMode` state machine and complete editor integration.

- [ ] **Step 1: Add failing pure transition tests**

Keep the smallest non-DOM decisions in `client_edit_lease.ts`, including:

```typescript
export function canMutateCanvas(mode: EditorLeaseMode): boolean {
  return mode === "active";
}

export function shouldReadLocalDraft(mode: EditorLeaseMode): boolean {
  return mode === "active";
}
```

Test that `viewer`, `blocked`, `readonly`, `handoff`, and `lost` never read local drafts, and that `handoff` allows only the explicit held-lease flush path.

- [ ] **Step 2: Split permission from canvas lease authority**

Replace the overloaded `canEdit` meaning with:

```typescript
const hasWritePermission = currentPermission !== "VIEWER" && !isDeleted;
const canEditCanvas = hasWritePermission && leaseMode === "active";
```

Title/share controls continue using their existing permission checks. Canvas `readOnly`, `handleChange`, Ctrl/Cmd+S, history restore, and recovery resolution use lease state.

- [ ] **Step 3: Acquire before recovery or editable mount**

For VIEWER/deleted, enter `viewer` and preserve the existing server-only/localStorage-bypass behavior.

For writable access:

1. create/reuse sessionStorage client ID and a fresh in-memory candidate token;
2. enter `acquiring` and call acquire;
3. on success, store credentials in a ref, fetch `/api/documents/{id}` for the latest scene, then run the existing draft decision;
4. on `EDIT_LEASE_HELD`, enter `blocked` and render `EditLeaseConflictModal`;
5. do not mount editable Excalidraw or call `localStorage.getItem()` before `active`.

- [ ] **Step 4: Implement read-only choice and later takeover entry**

`Open read-only` fetches and mounts the latest server scene, enters `readonly`, and never reads/deletes the draft. Render a persistent banner with `Take over editing` for writable users in lease-read-only mode.

- [ ] **Step 5: Implement heartbeat and graceful handoff**

Start one two-second timer only in `active`. On a pending takeover response:

1. enter `handoff` immediately so new `onChange` events are ignored;
2. clear auto-save debounce;
3. call the existing save pipeline with `isManualSave: false` and `snapshotDue: false` even when the last auto-save was recent;
4. on save success, release/acknowledge so the server transfers the lease;
5. fetch latest server scene and enter `readonly`;
6. on save failure, preserve the draft, show the error, and wait for forced loss rather than acknowledging.

Use a ref guard so repeated heartbeat responses cannot start multiple handoff saves.

- [ ] **Step 6: Implement requester polling and forced transfer**

After `request_takeover`, poll once per second until acquired, superseded, or 10 seconds have elapsed according to server state. On acquisition, fetch the latest server scene and only then run local draft recovery. Never use a client timer to grant authority without a successful server response.

- [ ] **Step 7: Centralize `EDIT_LEASE_LOST` handling**

Heartbeat, save, recovery, and restore errors route to one callback. It cancels timers, retains any draft, clears in-memory credentials, fetches latest server state, and enters `lost`/read-only with the required status message.

Do not let a rejected stale save clear `isDirtyRef` or localStorage.

- [ ] **Step 8: Release best-effort on page exit**

On `pagehide`, send the current credentials to the same action endpoint using `navigator.sendBeacon` where available, with credentialed `fetch(..., { keepalive: true })` fallback. Release may run whether clean or dirty because local draft recovery is the durability fallback. Do not block navigation.

- [ ] **Step 9: Pass credentials to every mutation**

- Auto-save and manual save: required `saveDocumentScene({ lease })`.
- Recovery: required `resolveClientRecovery({ lease })`.
- History restore: send JSON `{ lease }` while retaining the existing `versionId` query.
- If no active credentials exist, do not send the mutation.

- [ ] **Step 10: Run focused integration tests and typecheck**

```powershell
npm test -- tests/client_edit_lease.test.ts tests/client_save_pipeline.test.ts tests/edit_lease_modal.test.ts tests/recovery_modal.test.ts tests/edit_lease_fencing.test.ts
npm run typecheck
```

Expected: all targeted tests pass and TypeScript reports zero errors.

- [ ] **Step 11: Commit editor integration**

```powershell
git add -- "src/app/documents/[id]/EditorClient.tsx" "src/lib/client_edit_lease.ts" "tests/client_edit_lease.test.ts" "tests/client_save_pipeline.test.ts"
git commit -m "feat(lease): integrate single-editor takeover flow"
```

---

### Task 7: Documentation and Full Automated Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/CHECKLIST.md`
- Modify: `docs/superpowers/specs/2026-09-01-document-edit-lease-design.md`
- Verify: every runtime and test file changed in Tasks 1-6

**Interfaces:**
- Consumes: completed lease feature.
- Produces: current behavior documentation, automated evidence, and a clean feature branch ready for Senior review.

- [ ] **Step 1: Run the complete automated suite**

```powershell
npm test
npm run typecheck
```

Expected: all Vitest tests pass and TypeScript reports zero errors. Do not run `npm run build`.

- [ ] **Step 2: Update existing product documentation**

Document:

- one editor per document;
- read-only and takeover choices;
- 2-second heartbeat, 10-second takeover, 90-second expiry;
- local draft preservation after lease loss;
- VIEWER server-only behavior;
- no real-time collaboration.

Add unchecked manual browser cases to `docs/CHECKLIST.md` because the user, not the Worker, will execute them. Do not mark browser E2E/manual cases complete.

Change the spec status to `Implemented — automated verification complete; manual browser verification pending` only after Step 1 passes.

- [ ] **Step 3: Review scope and whitespace**

```powershell
git diff --check
git status --short
git diff --stat HEAD~7..HEAD
git log --oneline --decorate -10
```

Expected: no dependency/lockfile changes, no build output, and no files outside the plan without a documented implementation reason.

- [ ] **Step 4: Commit verification documentation**

```powershell
git add -- "README.md" "docs/CHECKLIST.md" "docs/superpowers/specs/2026-09-01-document-edit-lease-design.md"
git commit -m "docs: document single-editor lease behavior"
```

- [ ] **Step 5: Report Worker completion once**

The `worker_done` report must include:

- branch and commit list;
- exact files changed;
- targeted and full test counts/results;
- typecheck result;
- confirmation that build and browser E2E were not run;
- remaining manual browser cases;
- any deviation from this plan and its reason.

---

## Acceptance Summary

- One active canvas editor exists per document across accounts, browsers, devices, and tabs.
- A second writable screen can open read-only or request takeover.
- Normal takeover flushes the old scene without creating a forced snapshot; forced takeover completes after at most 10 seconds.
- Token/generation fencing prevents every stale scene, recovery, snapshot, and restore write.
- The old editor becomes read-only and retains any unconfirmed local draft.
- The new editor reloads the latest server scene before existing local draft conflict resolution.
- VIEWER always sees server state without localStorage access or lease participation.
- Title and sharing controls remain outside the lease.
- No new dependency, collaboration transport, build, or browser E2E is included.
