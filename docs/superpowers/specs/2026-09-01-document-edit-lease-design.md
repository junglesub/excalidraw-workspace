# Document-Scoped Single-Editor Lease Requirements and Design

**Date:** 2026-09-01
**Status:** Implemented — automated verification complete; manual browser verification pending
**Scope:** One active canvas editor per document across users, browsers, devices, and tabs

## 1. Goal

Prevent concurrent scene writes without introducing real-time collaboration. A writable document may have exactly one active editing screen. Other writable users may open the latest server state read-only or request takeover.

The implementation must protect server state even when an old browser continues sending delayed requests after takeover. It must also preserve the existing localStorage recovery behavior without exposing local drafts to VIEWER users.

## 2. Included behavior

- One active canvas editor lease per document.
- Lease acquisition before mounting an editable canvas.
- A blocking conflict prompt when another screen owns the lease.
- `Open read-only` and `Take over editing` choices.
- Graceful takeover: request the current editor to flush its latest scene, then transfer the lease.
- Forced takeover after a maximum 10-second wait.
- Server-side fencing of stale writes using a random lease token and monotonically increasing generation.
- Heartbeat and lease expiry for crashed or disconnected tabs.
- Integration with auto-save, manual save, history restore, and local draft recovery.
- Clear status messages when editing is taken over or a lease is lost.

## 3. Excluded behavior

- Real-time collaborative editing, presence, cursors, CRDTs, WebSockets, SSE, or long-polling.
- A takeover queue. Only one pending takeover request is accepted per document.
- Lease enforcement for title rename, sharing, permission management, attachment upload, import, trash, or document restore from Trash.
- Browser E2E automation. The user will perform browser acceptance manually.
- New dependencies or a production build.

Attachment uploads remain permission-gated. An upload made by a stale editor cannot become part of the document because the following scene write is fenced; existing attachment cleanup handles unreferenced uploads.

## 4. Roles and modes

### VIEWER

VIEWER always receives the current server scene in read-only mode.

- Never acquire, heartbeat, release, or take over a lease.
- Never inspect, compare, remove, or modify a local draft.
- Never display the lease conflict prompt.

### Writable user without a lease

OWNER, EDITOR, or an administrator with effective write access starts behind a lease gate. Until a lease is acquired, the editable canvas must not mount and local draft recovery must not run.

If another holder exists, display its username and offer:

- `Open read-only`: fetch and show the latest server scene without touching localStorage.
- `Take over editing`: begin the 10-second graceful handoff flow.

A user who selected read-only may later press `Take over editing` from a visible read-only banner.

### Active lease holder

Only the active holder may change the canvas, auto-save, manually save, resolve a local/server draft conflict, or restore a history version.

Title rename and sharing remain controlled by their existing permissions and do not require a lease.

## 5. Timing constants

```text
Heartbeat interval:       2 seconds
Lease expiry:             90 seconds after the last accepted heartbeat
Takeover status polling:  1 second
Takeover deadline:        10 seconds
Auto-save debounce:       existing 3 seconds
```

The generous lease expiry reduces accidental loss when browsers throttle background timers. It does not delay takeover: a requester may force transfer after 10 seconds regardless of lease expiry.

## 6. Persistence model

Add one SQLite table. Existing databases migrate through `CREATE TABLE IF NOT EXISTS`; no existing table or row needs rewriting.

```sql
CREATE TABLE IF NOT EXISTS document_edit_leases (
  document_id             TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  holder_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  holder_client_id        TEXT,
  lease_token             TEXT,
  generation              INTEGER NOT NULL,
  acquired_at             TEXT,
  heartbeat_at            TEXT,
  expires_at              TEXT,
  takeover_request_id     TEXT,
  takeover_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  takeover_client_id      TEXT,
  takeover_lease_token    TEXT,
  takeover_requested_at   TEXT,
  takeover_deadline_at    TEXT
);
```

The client ID is the per-browsing-context id from `window.name` (a non-secret identifier that survives same-tab reload/navigation and is not inherited by opener-created or duplicated contexts) and identifies the context for diagnostics and retry behavior. Lease authority never depends on the client ID alone. Each editor page instance generates a fresh random candidate lease token in memory; a same-context re-entry presents the previous server-issued token + generation (persisted in `sessionStorage` keyed by `{docId}:{contextId}`) as proof. A duplicated tab inherits that stored proof but, under its own `window.name` id, cannot present valid prior credentials for the live holder's clientId.

The server owns `generation`. Every successful initial acquisition starts or advances it, and every takeover advances it. An ordinary release clears holder fields but retains the row and generation so a later acquisition cannot reset the fencing sequence. A scene mutation is valid only when user ID, client ID, lease token, generation, and non-expired lease all match in the same database transaction as the mutation.

Raw lease tokens are random UUIDs and are scoped to one document. They must not be logged or displayed.

## 7. Server lease state machine

### Acquire

Within an immediate SQLite transaction:

1. Verify effective write permission and that the document is not deleted.
2. If no row exists, or its holder is absent or expired, install the caller as holder, advance generation, and return credentials.
3. If all supplied credentials already match the holder, treat the request as idempotent and return the current lease.
4. Otherwise return `409 EDIT_LEASE_HELD` with safe holder metadata only.

### Heartbeat

Validate the complete lease credentials, update `heartbeat_at` and `expires_at`, and return any pending takeover request. A mismatch or expired lease returns `409 EDIT_LEASE_LOST`.

### Request takeover

1. Verify write permission.
2. If the lease is absent or expired, acquire immediately.
3. If no takeover is pending, store one random request ID and the requester's candidate lease credentials with a deadline 10 seconds later.
4. If a request is already pending and has not expired, return `409 TAKEOVER_IN_PROGRESS`. Do not queue another request.
5. A requester may retry its own request idempotently using its request ID.

### Graceful transfer

The current holder learns of takeover from its next heartbeat response, no later than approximately two seconds under normal scheduling.

1. Freeze canvas mutation locally.
2. Cancel the debounce timer.
3. Upload outstanding attachments and issue a normal scene save using the current lease. Do not force a manual/history snapshot.
4. If save succeeds, call release/acknowledge with the current credentials.
5. The server atomically installs the pending requester as holder, advances generation, and clears pending fields.
6. The old editor fetches the latest server scene and becomes read-only.

If the flush fails, do not acknowledge transfer. Preserve the local draft and show an error. The requester may still force transfer at the deadline.

### Forced transfer

The requester polls once per second. At or after the stored deadline, its status request atomically installs its pre-registered candidate token as the new holder, advances generation, and clears pending fields.

The old token becomes invalid immediately. Any late heartbeat, auto-save, manual save, recovery resolution, or version restore returns `409 EDIT_LEASE_LOST` and cannot mutate document or history state.

### Release

An ordinary release clears the holder and pending fields but retains the row and generation. If the holder releases while a takeover is pending, release performs the graceful transfer instead.

On `pagehide`, the browser sends a best-effort credentialed release using `navigator.sendBeacon` or `fetch(..., { keepalive: true })`. Local draft safety must not depend on release succeeding.

### Re-entry semantics

The lease `clientId` is the per-browsing-context id from `window.name`, a non-secret property of the browsing context that survives same-tab reloads and same-origin navigations and is reset on cross-domain loads. Per MDN it is NOT inherited by newly opened editor contexts (a `window.open`/target target starts unnamed; the editor never assigns opener names). Each page instance generates a fresh lease token and persists the previous server-issued token + generation in `sessionStorage` keyed by `{docId}:{contextId}`.

The server rotates/generates a new lease only when the active holder exactly matches user + clientId + prior token + prior generation. This is the only proof of re-entry; there is no boolean bypass. On success the fresh token and an advanced generation fence the previous page instance's in-flight requests (including a late pagehide release).

A copied-storage context (opener-created or duplicated) has its own `window.name` id, so it cannot present valid prior credentials for the active holder's clientId and stays behind the conflict prompt with the takeover path, as does any different context. Immediate no-takeover recovery is only possible once the holder heartbeat is stale (past the 10-second takeover deadline), and it never destroys a structurally valid pending takeover.


## 8. API contract

Use one route at `/api/documents/[id]/lease` with action-based JSON requests. This keeps the disposable lease subsystem in one API file.

```typescript
type LeaseAction =
  | "acquire"
  | "heartbeat"
  | "request_takeover"
  | "poll_takeover"
  | "release";

interface LeaseCredentials {
  clientId: string;
  leaseToken: string;
  generation: number;
}
```

All responses use explicit states and stable error codes:

```typescript
type LeaseState = "acquired" | "held" | "takeover_pending" | "takeover_in_progress" | "lost";

interface LeaseHolderSummary {
  username: string;
  acquiredAt: string;
  heartbeatAt: string;
}
```

Never return another holder's token, client ID, or pending takeover token.

Scene mutation payloads include `lease: LeaseCredentials`:

- `PUT /api/documents/[id]/scene`
- `POST /api/documents/[id]/save`
- `POST /api/documents/[id]/recovery`
- `POST /api/documents/[id]/versions?action=restore&versionId=...`

Lease validation and the corresponding database mutation must share one immediate transaction. A preflight route check followed by a separate write transaction is not sufficient because takeover could occur between them.

## 9. Client load ordering

```text
Load document page
  ├─ VIEWER/deleted → mount server scene read-only; never touch localStorage
  └─ writable
       └─ acquire lease before editable canvas mount
            ├─ acquired
            │    └─ fetch latest server scene
            │         └─ run existing local draft comparison
            │              ├─ no mismatch → mount editable canvas
            │              └─ mismatch → existing recovery modal
            └─ held
                 └─ show lease conflict prompt
                      ├─ Open read-only → fetch server scene; no localStorage access
                      └─ Take over → graceful/forced handoff
                           └─ fetch latest server scene
                                └─ run existing local draft comparison
```

The local recovery modal remains unchanged in meaning: after lease acquisition, a mismatch requires choosing Client draft or Server version, with preservation of the unselected version enabled by default.

If the lease is lost while the recovery modal is open, close the recovery flow without deleting the draft, load the latest server scene, and enter read-only mode.

## 10. Client runtime states

Use explicit states rather than one overloaded `canEdit` boolean:

```typescript
type EditorLeaseMode =
  | "viewer"
  | "acquiring"
  | "blocked"
  | "active"
  | "handoff"
  | "readonly"
  | "lost";
```

- `active` permits canvas changes and scene mutations.
- `handoff` freezes new canvas changes but permits exactly the current lease flush.
- `readonly`, `viewer`, and `lost` mount the latest server scene read-only.
- Existing title and share controls continue to use permission, not lease mode.

When any API returns `EDIT_LEASE_LOST`, perform one centralized transition:

1. cancel debounce and heartbeat timers;
2. do not clear the scoped local draft;
3. fetch and mount the latest server scene read-only;
4. display `Editing was taken over. Unsaved local changes were kept for recovery.` when dirty, otherwise `Editing moved to another screen.`

## 11. Failure and race handling

- All lease transitions are immediate SQLite transactions.
- Server time is authoritative for heartbeat, expiry, and takeover deadlines.
- A response lost after acquisition is safe because the same candidate token makes acquisition idempotent.
- Multiple takeover requesters are not queued; the first active request owns the 10-second attempt.
- A requester that disappears may temporarily become holder after graceful transfer, but its lease expires normally and another user can take over after 10 seconds.
- Network failure retains the local draft. It never grants write access based only on client belief.
- A stale client may remain visually open but cannot mutate server state after generation changes.
- Permission revocation causes the next heartbeat or mutation to fail and transitions the client to read-only.

## 12. Automated verification

At minimum, automated tests must cover:

1. first acquisition and idempotent retry;
2. conflict response without token leakage;
3. heartbeat renewal and expiry takeover;
4. first-request-wins takeover behavior;
5. graceful and forced generation advancement;
6. stale token/generation rejection;
7. atomic fencing of auto-save, manual save, recovery, and restore;
8. VIEWER denial and deleted-document denial;
9. client transport credentials on every fenced mutation;
10. lease conflict modal accessibility and required choices;
11. localStorage bypass in viewer and lease-read-only modes;
12. local draft retention after lease loss.

Run the relevant Vitest files, the full test suite, TypeScript typecheck, and `git diff --check`. Do not run a production build or browser E2E.

## 13. Future replacement

This lease is intentionally not a collaboration foundation. A future self-hosted collaboration room replaces the lease for collaborative documents. Do not add WebSocket, SSE, presence, CRDT, Redis, or generic distributed-lock abstractions now.
