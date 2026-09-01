import { getDb, transaction } from "./db";
import { getDocumentRaw, requireWrite } from "./documents";
import { HttpError } from "./http";
import type { EditLeaseCredentials, LeaseHolderSummary } from "./types";
import { getById as getUserById } from "./users";

export const LEASE_HEARTBEAT_MS = 2_000;
export const LEASE_TTL_MS = 90_000;
export const TAKEOVER_POLL_MS = 1_000;
export const TAKEOVER_TIMEOUT_MS = 10_000;

export type LeaseState = "acquired" | "held" | "takeover_pending" | "takeover_in_progress" | "lost";

export interface LeaseAcquiredResult {
  state: "acquired";
  documentId: string;
  generation: number;
  clientId: string;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface LeaseHeldResult {
  state: "held";
  holder: LeaseHolderSummary;
}

export interface LeaseTakeoverPendingResult {
  state: "takeover_pending";
  holder: LeaseHolderSummary;
  requestId: string;
  requestedAt: string;
  deadlineAt: string;
}

export interface LeaseTakeoverInProgressResult {
  state: "takeover_in_progress";
  holder: LeaseHolderSummary;
  requestId: string;
  deadlineAt: string;
}

export interface LeaseReleasedResult {
  state: "released";
}

export interface LeaseTransferredResult {
  state: "transferred";
}

export type LeaseResult =
  | LeaseAcquiredResult
  | LeaseHeldResult
  | LeaseTakeoverPendingResult
  | LeaseTakeoverInProgressResult
  | LeaseReleasedResult
  | LeaseTransferredResult;

interface LeaseRow {
  document_id: string;
  holder_user_id: string | null;
  holder_client_id: string | null;
  lease_token: string | null;
  generation: number;
  acquired_at: string | null;
  heartbeat_at: string | null;
  expires_at: string | null;
  takeover_request_id: string | null;
  takeover_user_id: string | null;
  takeover_client_id: string | null;
  takeover_lease_token: string | null;
  takeover_requested_at: string | null;
  takeover_deadline_at: string | null;
}

export interface LeaseIdentityInput {
  docId: string;
  userId: string;
  role: "USER" | "ADMIN";
  adminMode: boolean;
  clientId: string;
  leaseToken: string;
}

export interface ActiveLeaseInput extends LeaseIdentityInput {
  generation: number;
}

export interface TakeoverInput extends LeaseIdentityInput {
  requestId?: string;
}

export interface PollTakeoverInput extends LeaseIdentityInput {
  requestId: string;
  generation?: number;
}

function isExpired(row: LeaseRow, now: Date): boolean {
  if (!row.expires_at) return true;
  const exp = Date.parse(row.expires_at);
  if (Number.isNaN(exp)) return true;
  return exp <= now.getTime();
}

function isTakeoverExpired(row: LeaseRow, now: Date): boolean {
  if (!row.takeover_deadline_at) return true;
  const d = Date.parse(row.takeover_deadline_at);
  if (Number.isNaN(d)) return true;
  return d <= now.getTime();
}

function holderSummaryFromRow(row: LeaseRow): LeaseHolderSummary {
  const userId = row.holder_user_id;
  let username = "unknown";
  if (userId) {
    try {
      const u = getUserById(userId);
      if (u) username = u.username;
    } catch {
      // ignore
    }
  }
  return {
    username,
    acquiredAt: row.acquired_at || "",
    heartbeatAt: row.heartbeat_at || "",
  };
}

function toAcquiredResult(row: LeaseRow): LeaseAcquiredResult {
  return {
    state: "acquired",
    documentId: row.document_id,
    generation: row.generation,
    clientId: row.holder_client_id || "",
    leaseToken: row.lease_token || "",
    acquiredAt: row.acquired_at || "",
    heartbeatAt: row.heartbeat_at || "",
    expiresAt: row.expires_at || "",
  };
}

function validateNotDeleted(docId: string): void {
  const doc = getDocumentRaw(docId);
  if (!doc) throw new HttpError(404, "Document not found");
  if (doc.deleted_at !== null && doc.deleted_at !== undefined) {
    throw new HttpError(404, "Document not found");
  }
}

function validateWritePermission(input: { docId: string; userId: string; role: "USER" | "ADMIN"; adminMode: boolean }): void {
  validateNotDeleted(input.docId);
  requireWrite(input.docId, input.userId, input.role, input.adminMode);
}

export function parseAndValidateLeaseCredentials(body: Record<string, unknown>): EditLeaseCredentials | null {
  const clientId = body.clientId;
  const leaseToken = body.leaseToken;
  const generation = body.generation;
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 256) return null;
  if (typeof leaseToken !== "string" || leaseToken.length === 0 || leaseToken.length > 256) return null;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0) return null;
  return { clientId, leaseToken, generation };
}

function getLeaseRow(docId: string): LeaseRow | undefined {
  return getDb().prepare("SELECT * FROM document_edit_leases WHERE document_id = ?").get(docId) as LeaseRow | undefined;
}

export function acquireEditLease(input: LeaseIdentityInput, now?: Date): LeaseResult {
  const nowDate = now ?? new Date();
  return transaction(() => {
    validateWritePermission(input);
    const row = getLeaseRow(input.docId);

    if (!row || !row.holder_user_id || isExpired(row, nowDate)) {
      const generation = (row?.generation ?? 0) + 1;
      const iso = nowDate.toISOString();
      const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
      if (!row) {
        getDb()
          .prepare(
            `INSERT INTO document_edit_leases (document_id, holder_user_id, holder_client_id, lease_token, generation, acquired_at, heartbeat_at, expires_at, takeover_request_id, takeover_user_id, takeover_client_id, takeover_lease_token, takeover_requested_at, takeover_deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
          )
          .run(input.docId, input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt);
      } else {
        getDb()
          .prepare(
            `UPDATE document_edit_leases SET holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE document_id=?`,
          )
          .run(input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt, input.docId);
      }
      const updated = getLeaseRow(input.docId)!;
      return toAcquiredResult(updated);
    }

    // Valid holder exists
    if (
      row.holder_user_id === input.userId &&
      row.holder_client_id === input.clientId &&
      row.lease_token === input.leaseToken
    ) {
      // Idempotent reacquire for same complete credentials; also update heartbeat? Acquire is idempotent: return current lease without advancing generation
      // Update heartbeat/expires to keep lease alive on reacquire? Spec says idempotent return current lease. We'll refresh heartbeat.
      const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
      getDb()
        .prepare(`UPDATE document_edit_leases SET heartbeat_at=?, expires_at=? WHERE document_id=?`)
        .run(nowDate.toISOString(), expiresAt, input.docId);
      const updated = getLeaseRow(input.docId)!;
      return toAcquiredResult(updated);
    }

    // Held by another
    return {
      state: "held",
      holder: holderSummaryFromRow(row),
    } as LeaseHeldResult;
  });
}

export function heartbeatEditLease(input: ActiveLeaseInput, now?: Date): LeaseResult {
  const nowDate = now ?? new Date();
  return transaction(() => {
    validateWritePermission(input);
    const row = getLeaseRow(input.docId);
    if (!row || !row.holder_user_id) {
      throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
    }
    if (
      row.holder_user_id !== input.userId ||
      row.holder_client_id !== input.clientId ||
      row.lease_token !== input.leaseToken ||
      row.generation !== input.generation ||
      isExpired(row, nowDate)
    ) {
      throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
    }
    // Valid heartbeat: update heartbeat_at and expires_at
    const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
    getDb()
      .prepare(`UPDATE document_edit_leases SET heartbeat_at=?, expires_at=? WHERE document_id=?`)
      .run(nowDate.toISOString(), expiresAt, input.docId);
    const updated = getLeaseRow(input.docId)!;
    if (updated.takeover_request_id && !isTakeoverExpired(updated, nowDate)) {
      return {
        state: "takeover_pending",
        holder: holderSummaryFromRow(updated),
        requestId: updated.takeover_request_id,
        requestedAt: updated.takeover_requested_at || "",
        deadlineAt: updated.takeover_deadline_at || "",
      } as LeaseTakeoverPendingResult;
    }
    return toAcquiredResult(updated);
  });
}

export function requestEditTakeover(input: TakeoverInput, now?: Date): LeaseResult {
  const nowDate = now ?? new Date();
  return transaction(() => {
    validateWritePermission(input);
    const row = getLeaseRow(input.docId);

    // If absent or expired, acquire immediately
    if (!row || !row.holder_user_id || isExpired(row, nowDate)) {
      const generation = (row?.generation ?? 0) + 1;
      const iso = nowDate.toISOString();
      const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
      if (!row) {
        getDb()
          .prepare(
            `INSERT INTO document_edit_leases (document_id, holder_user_id, holder_client_id, lease_token, generation, acquired_at, heartbeat_at, expires_at, takeover_request_id, takeover_user_id, takeover_client_id, takeover_lease_token, takeover_requested_at, takeover_deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
          )
          .run(input.docId, input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt);
      } else {
        getDb()
          .prepare(
            `UPDATE document_edit_leases SET holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE document_id=?`,
          )
          .run(input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt, input.docId);
      }
      const updated = getLeaseRow(input.docId)!;
      return toAcquiredResult(updated);
    }

    // If holder is same as requester (idempotent), return acquired
    if (
      row.holder_user_id === input.userId &&
      row.holder_client_id === input.clientId &&
      row.lease_token === input.leaseToken
    ) {
      const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
      getDb().prepare(`UPDATE document_edit_leases SET heartbeat_at=?, expires_at=? WHERE document_id=?`).run(nowDate.toISOString(), expiresAt, input.docId);
      const updated = getLeaseRow(input.docId)!;
      return toAcquiredResult(updated);
    }

    // Check existing pending
    const hasPending = !!row.takeover_request_id && !isTakeoverExpired(row, nowDate);
    if (hasPending) {
      // If same requester retries with same requestId, idempotent
      if (input.requestId && row.takeover_request_id === input.requestId) {
        if (
          row.takeover_user_id === input.userId &&
          row.takeover_client_id === input.clientId &&
          row.takeover_lease_token === input.leaseToken
        ) {
          return {
            state: "takeover_pending",
            holder: holderSummaryFromRow(row),
            requestId: row.takeover_request_id!,
            requestedAt: row.takeover_requested_at || "",
            deadlineAt: row.takeover_deadline_at || "",
          } as LeaseTakeoverPendingResult;
        }
      }
      // Different requester or same but not matching: return takeover_in_progress
      return {
        state: "takeover_in_progress",
        holder: holderSummaryFromRow(row),
        requestId: row.takeover_request_id!,
        deadlineAt: row.takeover_deadline_at || "",
      } as LeaseTakeoverInProgressResult;
    }

    // No pending or expired pending: store new request
    const requestId = input.requestId || crypto.randomUUID();
    const requestedAt = nowDate.toISOString();
    const deadlineAt = new Date(nowDate.getTime() + TAKEOVER_TIMEOUT_MS).toISOString();
    getDb()
      .prepare(
        `UPDATE document_edit_leases SET takeover_request_id=?, takeover_user_id=?, takeover_client_id=?, takeover_lease_token=?, takeover_requested_at=?, takeover_deadline_at=? WHERE document_id=?`,
      )
      .run(requestId, input.userId, input.clientId, input.leaseToken, requestedAt, deadlineAt, input.docId);
    const updated = getLeaseRow(input.docId)!;
    return {
      state: "takeover_pending",
      holder: holderSummaryFromRow(updated),
      requestId,
      requestedAt,
      deadlineAt,
    } as LeaseTakeoverPendingResult;
  });
}

export function pollEditTakeover(input: PollTakeoverInput, now?: Date): LeaseResult {
  const nowDate = now ?? new Date();
  return transaction(() => {
    validateWritePermission(input);
    const row = getLeaseRow(input.docId);
    if (!row || !row.holder_user_id) {
      throw new HttpError(404, "Lease not found", "EDIT_LEASE_LOST");
    }
    if (!row.takeover_request_id) {
      // No pending; return held if not holder, acquired if holder matches
      if (
        row.holder_user_id === input.userId &&
        row.holder_client_id === input.clientId &&
        row.lease_token === input.leaseToken
      ) {
        return toAcquiredResult(row);
      }
      return {
        state: "held",
        holder: holderSummaryFromRow(row),
      } as LeaseHeldResult;
    }

    const isPendingMatches =
      row.takeover_request_id === input.requestId &&
      row.takeover_user_id === input.userId &&
      row.takeover_client_id === input.clientId &&
      row.takeover_lease_token === input.leaseToken;

    const deadline = row.takeover_deadline_at ? Date.parse(row.takeover_deadline_at) : NaN;
    const hasDeadlinePassed = !Number.isNaN(deadline) && nowDate.getTime() >= deadline;

    if (isPendingMatches && hasDeadlinePassed) {
      // Forced transfer: atomically install requester as holder, advance generation, clear pending
      const newGeneration = row.generation + 1;
      const iso = nowDate.toISOString();
      const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
      getDb()
        .prepare(
          `UPDATE document_edit_leases SET holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE document_id=?`,
        )
        .run(input.userId, input.clientId, input.leaseToken, newGeneration, iso, iso, expiresAt, input.docId);
      const updated = getLeaseRow(input.docId)!;
      return toAcquiredResult(updated);
    }

    if (isPendingMatches && !hasDeadlinePassed) {
      return {
        state: "takeover_pending",
        holder: holderSummaryFromRow(row),
        requestId: row.takeover_request_id,
        requestedAt: row.takeover_requested_at || "",
        deadlineAt: row.takeover_deadline_at || "",
      } as LeaseTakeoverPendingResult;
    }

    // Pending belongs to someone else
    if (!isPendingMatches && row.takeover_request_id) {
      if (!isTakeoverExpired(row, nowDate)) {
        return {
          state: "takeover_in_progress",
          holder: holderSummaryFromRow(row),
          requestId: row.takeover_request_id,
          deadlineAt: row.takeover_deadline_at || "",
        } as LeaseTakeoverInProgressResult;
      } else {
        // Expired pending owned by other; allow new takeover? For poll, just return held
        return {
          state: "held",
          holder: holderSummaryFromRow(row),
        } as LeaseHeldResult;
      }
    }

    // Fallback held
    return {
      state: "held",
      holder: holderSummaryFromRow(row),
    } as LeaseHeldResult;
  });
}

export function releaseEditLease(input: ActiveLeaseInput, now?: Date): LeaseResult {
  const nowDate = now ?? new Date();
  return transaction(() => {
    const row = getLeaseRow(input.docId);
    if (!row || !row.holder_user_id) {
      if (row) return { state: "released" } as LeaseReleasedResult;
      throw new HttpError(404, "Lease not found", "EDIT_LEASE_LOST");
    }
    const expired = isExpired(row, nowDate);
    if (
      row.holder_user_id !== input.userId ||
      row.holder_client_id !== input.clientId ||
      row.lease_token !== input.leaseToken ||
      row.generation !== input.generation ||
      expired
    ) {
      throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
    }

    // If takeover pending with structurally valid request, perform graceful/forced transfer instead of ordinary release.
    // A structurally valid pending must not be destroyed by late release at/after deadline.
    const hasStructurallyValidPending =
      !!row.takeover_request_id &&
      !!row.takeover_user_id &&
      !!row.takeover_client_id &&
      !!row.takeover_lease_token &&
      !!row.takeover_requested_at &&
      !!row.takeover_deadline_at;

    if (hasStructurallyValidPending) {
      const newGeneration = row.generation + 1;
      const iso = nowDate.toISOString();
      const expiresAt = new Date(nowDate.getTime() + LEASE_TTL_MS).toISOString();
      getDb()
        .prepare(
          `UPDATE document_edit_leases SET holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE document_id=?`,
        )
        .run(row.takeover_user_id, row.takeover_client_id, row.takeover_lease_token, newGeneration, iso, iso, expiresAt, input.docId);
      // Safe: do not expose new holder's token/clientId to old holder
      return { state: "transferred" } as LeaseTransferredResult;
    }

    // Ordinary release: clear holder and pending but retain generation
    getDb()
      .prepare(
        `UPDATE document_edit_leases SET holder_user_id=NULL, holder_client_id=NULL, lease_token=NULL, acquired_at=NULL, heartbeat_at=NULL, expires_at=NULL, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE document_id=?`,
      )
      .run(input.docId);
    return { state: "released" } as LeaseReleasedResult;
  });
}

export function assertActiveEditLease(input: ActiveLeaseInput, now?: Date): void {
  const nowDate = now ?? new Date();
  // Use transaction to ensure atomic validation inside caller's transaction? This function itself wraps in transaction but callers will call it inside their own transaction; nested BEGIN IMMEDIATE would fail. So we do not start new transaction if already inside?
  // We'll implement check without wrapping in transaction, just SELECT and validate within current transaction context (SQLite BEGIN IMMEDIATE is idempotent? No nested). But spec says lease validation and mutation must share one immediate transaction. So assertActiveEditLease will be called inside caller's transaction which already has BEGIN IMMEDIATE. So we must NOT start a new transaction here if already in transaction.
  // For standalone calls, we can still validate without transaction; we emulate by not using transaction wrapper here.
  // However to keep consistent, we will run validation directly; if caller is not in transaction, SELECT is okay.
  const db = getDb();
  // Check permission and deleted first
  validateWritePermission(input);
  const row = getLeaseRow(input.docId);
  if (!row || !row.holder_user_id) {
    throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
  }
  if (
    row.holder_user_id !== input.userId ||
    row.holder_client_id !== input.clientId ||
    row.lease_token !== input.leaseToken ||
    row.generation !== input.generation ||
    isExpired(row, nowDate)
  ) {
    throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
  }
  // valid => no throw
}
