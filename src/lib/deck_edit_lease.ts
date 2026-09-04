import { getDb, transaction } from "./db";
import { getDeck } from "./decks";
import { HttpError } from "./http";
import type { LeaseHolderSummary } from "./types";
import { getById as getUserById } from "./users";

export const DECK_LEASE_TTL_MS = 90_000;
export const TAKEOVER_TIMEOUT_MS = 10_000;

export interface DeckLeaseCredentials {
  clientId: string;
  leaseToken: string;
  generation: number;
}

export function parseDeckLeaseCredentials(value: unknown): DeckLeaseCredentials | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.clientId !== "string" || !record.clientId || record.clientId.length > 256) return null;
  if (typeof record.leaseToken !== "string" || !record.leaseToken || record.leaseToken.length > 256) return null;
  if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation <= 0) return null;
  return { clientId: record.clientId, leaseToken: record.leaseToken, generation: record.generation };
}

export interface DeckLeaseAcquiredResult {
  state: "acquired";
  deckId: string;
  generation: number;
  clientId: string;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface DeckLeaseHeldResult {
  state: "held";
  holder: LeaseHolderSummary;
}

export interface DeckLeaseTakeoverPendingResult {
  state: "takeover_pending";
  holder: LeaseHolderSummary;
  requestId: string;
  requestedAt: string;
  deadlineAt: string;
}

export interface DeckLeaseTakeoverInProgressResult {
  state: "takeover_in_progress";
  holder: LeaseHolderSummary;
  requestId: string;
  deadlineAt: string;
}

export type DeckLeaseResult =
  | DeckLeaseAcquiredResult
  | DeckLeaseHeldResult
  | DeckLeaseTakeoverPendingResult
  | DeckLeaseTakeoverInProgressResult
  | { state: "released" }
  | { state: "transferred" };

interface DeckLeaseRow {
  deck_id: string;
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

export interface DeckLeaseIdentityInput {
  deckId: string;
  userId: string;
  role: "USER" | "ADMIN";
  clientId: string;
  leaseToken: string;
  priorLeaseToken?: string;
  priorGeneration?: number;
}

export interface ActiveDeckLeaseInput extends DeckLeaseIdentityInput {
  generation: number;
}

export interface DeckTakeoverInput extends DeckLeaseIdentityInput {
  requestId?: string;
}

export interface DeckPollTakeoverInput extends DeckLeaseIdentityInput {
  requestId: string;
  generation?: number;
}

function validateDeckWrite(input: { deckId: string; userId: string; role: "USER" | "ADMIN" }): void {
  getDeck(input.deckId, input.userId, input.role);
}

function getLeaseRow(deckId: string): DeckLeaseRow | undefined {
  return getDb().prepare("SELECT * FROM deck_edit_leases WHERE deck_id = ?").get(deckId) as DeckLeaseRow | undefined;
}

function isExpired(row: DeckLeaseRow, now: Date): boolean {
  if (!row.expires_at) return true;
  const value = Date.parse(row.expires_at);
  return Number.isNaN(value) || value <= now.getTime();
}

function isTakeoverExpired(row: DeckLeaseRow, now: Date): boolean {
  if (!row.takeover_deadline_at) return true;
  const value = Date.parse(row.takeover_deadline_at);
  return Number.isNaN(value) || value <= now.getTime();
}

function holderSummary(row: DeckLeaseRow): LeaseHolderSummary {
  let username = "unknown";
  if (row.holder_user_id) {
    try {
      username = getUserById(row.holder_user_id)?.username ?? username;
    } catch {}
  }
  return {
    username,
    acquiredAt: row.acquired_at || "",
    heartbeatAt: row.heartbeat_at || "",
  };
}

function toAcquired(row: DeckLeaseRow): DeckLeaseAcquiredResult {
  return {
    state: "acquired",
    deckId: row.deck_id,
    generation: row.generation,
    clientId: row.holder_client_id || "",
    leaseToken: row.lease_token || "",
    acquiredAt: row.acquired_at || "",
    heartbeatAt: row.heartbeat_at || "",
    expiresAt: row.expires_at || "",
  };
}

export function acquireDeckEditLease(input: DeckLeaseIdentityInput, now = new Date()): DeckLeaseResult {
  return transaction(() => {
    validateDeckWrite(input);
    const row = getLeaseRow(input.deckId);
    if (!row || !row.holder_user_id || isExpired(row, now)) {
      const generation = (row?.generation ?? 0) + 1;
      const iso = now.toISOString();
      const expiresAt = new Date(now.getTime() + DECK_LEASE_TTL_MS).toISOString();
      if (!row) {
        getDb().prepare(`INSERT INTO deck_edit_leases (
          deck_id, holder_user_id, holder_client_id, lease_token, generation,
          acquired_at, heartbeat_at, expires_at, takeover_request_id, takeover_user_id,
          takeover_client_id, takeover_lease_token, takeover_requested_at, takeover_deadline_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`)
          .run(input.deckId, input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt);
      } else {
        getDb().prepare(`UPDATE deck_edit_leases SET
          holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?,
          takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL,
          takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE deck_id=?`)
          .run(input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt, input.deckId);
      }
      return toAcquired(getLeaseRow(input.deckId)!);
    }

    if (row.holder_user_id === input.userId && row.holder_client_id === input.clientId && row.lease_token === input.leaseToken) {
      const expiresAt = new Date(now.getTime() + DECK_LEASE_TTL_MS).toISOString();
      getDb().prepare("UPDATE deck_edit_leases SET heartbeat_at=?, expires_at=? WHERE deck_id=?")
        .run(now.toISOString(), expiresAt, input.deckId);
      return toAcquired(getLeaseRow(input.deckId)!);
    }

    if (row.holder_user_id === input.userId) {
      const lastBeat = row.heartbeat_at ? Date.parse(row.heartbeat_at) : NaN;
      const heartbeatStale = Number.isNaN(lastBeat) || now.getTime() - lastBeat > TAKEOVER_TIMEOUT_MS;
      const pendingBlocked = !!row.takeover_request_id && !isTakeoverExpired(row, now);
      const provenReentry =
        row.holder_client_id === input.clientId &&
        input.priorLeaseToken !== undefined &&
        row.lease_token === input.priorLeaseToken &&
        input.priorGeneration !== undefined &&
        row.generation === input.priorGeneration;
      if (!pendingBlocked && (provenReentry || heartbeatStale)) {
        const generation = row.generation + 1;
        const iso = now.toISOString();
        const expiresAt = new Date(now.getTime() + DECK_LEASE_TTL_MS).toISOString();
        getDb().prepare(`UPDATE deck_edit_leases SET
          holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?,
          takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL,
          takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE deck_id=?`)
          .run(input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt, input.deckId);
        return toAcquired(getLeaseRow(input.deckId)!);
      }
    }

    return { state: "held", holder: holderSummary(row) };
  });
}

export function heartbeatDeckEditLease(input: ActiveDeckLeaseInput, now = new Date()): DeckLeaseResult {
  return transaction(() => {
    validateDeckWrite(input);
    const row = getLeaseRow(input.deckId);
    if (!row || !row.holder_user_id || row.holder_user_id !== input.userId || row.holder_client_id !== input.clientId || row.lease_token !== input.leaseToken || row.generation !== input.generation || isExpired(row, now)) {
      throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
    }
    const expiresAt = new Date(now.getTime() + DECK_LEASE_TTL_MS).toISOString();
    getDb().prepare("UPDATE deck_edit_leases SET heartbeat_at=?, expires_at=? WHERE deck_id=?")
      .run(now.toISOString(), expiresAt, input.deckId);
    const updated = getLeaseRow(input.deckId)!;
    if (updated.takeover_request_id && !isTakeoverExpired(updated, now)) {
      return {
        state: "takeover_pending",
        holder: holderSummary(updated),
        requestId: updated.takeover_request_id,
        requestedAt: updated.takeover_requested_at || "",
        deadlineAt: updated.takeover_deadline_at || "",
      };
    }
    return toAcquired(updated);
  });
}

export function requestDeckEditTakeover(input: DeckTakeoverInput, now = new Date()): DeckLeaseResult {
  return transaction(() => {
    validateDeckWrite(input);
    const row = getLeaseRow(input.deckId);
    if (!row || !row.holder_user_id || isExpired(row, now)) return acquireDeckEditLease(input, now);
    if (row.holder_user_id === input.userId && row.holder_client_id === input.clientId && row.lease_token === input.leaseToken) return toAcquired(row);

    const hasPending = !!row.takeover_request_id && !isTakeoverExpired(row, now);
    if (hasPending) {
      if (input.requestId === row.takeover_request_id && row.takeover_user_id === input.userId && row.takeover_client_id === input.clientId && row.takeover_lease_token === input.leaseToken) {
        return {
          state: "takeover_pending",
          holder: holderSummary(row),
          requestId: row.takeover_request_id!,
          requestedAt: row.takeover_requested_at || "",
          deadlineAt: row.takeover_deadline_at || "",
        };
      }
      return { state: "takeover_in_progress", holder: holderSummary(row), requestId: row.takeover_request_id!, deadlineAt: row.takeover_deadline_at || "" };
    }

    const requestId = input.requestId || crypto.randomUUID();
    const requestedAt = now.toISOString();
    const deadlineAt = new Date(now.getTime() + TAKEOVER_TIMEOUT_MS).toISOString();
    getDb().prepare(`UPDATE deck_edit_leases SET takeover_request_id=?, takeover_user_id=?, takeover_client_id=?, takeover_lease_token=?, takeover_requested_at=?, takeover_deadline_at=? WHERE deck_id=?`)
      .run(requestId, input.userId, input.clientId, input.leaseToken, requestedAt, deadlineAt, input.deckId);
    return { state: "takeover_pending", holder: holderSummary(getLeaseRow(input.deckId)!), requestId, requestedAt, deadlineAt };
  });
}

export function pollDeckEditTakeover(input: DeckPollTakeoverInput, now = new Date()): DeckLeaseResult {
  return transaction(() => {
    validateDeckWrite(input);
    const row = getLeaseRow(input.deckId);
    if (!row || !row.holder_user_id) throw new HttpError(404, "Lease not found", "EDIT_LEASE_LOST");
    const matches = row.takeover_request_id === input.requestId && row.takeover_user_id === input.userId && row.takeover_client_id === input.clientId && row.takeover_lease_token === input.leaseToken;
    const deadline = row.takeover_deadline_at ? Date.parse(row.takeover_deadline_at) : NaN;
    const passed = !Number.isNaN(deadline) && now.getTime() >= deadline;
    if (matches && passed) {
      const generation = row.generation + 1;
      const iso = now.toISOString();
      const expiresAt = new Date(now.getTime() + DECK_LEASE_TTL_MS).toISOString();
      getDb().prepare(`UPDATE deck_edit_leases SET holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE deck_id=?`)
        .run(input.userId, input.clientId, input.leaseToken, generation, iso, iso, expiresAt, input.deckId);
      return toAcquired(getLeaseRow(input.deckId)!);
    }
    if (matches) {
      return { state: "takeover_pending", holder: holderSummary(row), requestId: row.takeover_request_id!, requestedAt: row.takeover_requested_at || "", deadlineAt: row.takeover_deadline_at || "" };
    }
    if (row.takeover_request_id && !isTakeoverExpired(row, now)) {
      return { state: "takeover_in_progress", holder: holderSummary(row), requestId: row.takeover_request_id, deadlineAt: row.takeover_deadline_at || "" };
    }
    return { state: "held", holder: holderSummary(row) };
  });
}

export function releaseDeckEditLease(input: ActiveDeckLeaseInput, now = new Date()): DeckLeaseResult {
  return transaction(() => {
    const row = getLeaseRow(input.deckId);
    if (!row || !row.holder_user_id) {
      if (row) return { state: "released" };
      throw new HttpError(404, "Lease not found", "EDIT_LEASE_LOST");
    }
    if (row.holder_user_id !== input.userId || row.holder_client_id !== input.clientId || row.lease_token !== input.leaseToken || row.generation !== input.generation || isExpired(row, now)) {
      throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
    }
    const pending = !!row.takeover_request_id && !!row.takeover_user_id && !!row.takeover_client_id && !!row.takeover_lease_token && !!row.takeover_requested_at && !!row.takeover_deadline_at;
    if (pending) {
      const generation = row.generation + 1;
      const iso = now.toISOString();
      const expiresAt = new Date(now.getTime() + DECK_LEASE_TTL_MS).toISOString();
      getDb().prepare(`UPDATE deck_edit_leases SET holder_user_id=?, holder_client_id=?, lease_token=?, generation=?, acquired_at=?, heartbeat_at=?, expires_at=?, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE deck_id=?`)
        .run(row.takeover_user_id, row.takeover_client_id, row.takeover_lease_token, generation, iso, iso, expiresAt, input.deckId);
      return { state: "transferred" };
    }
    getDb().prepare(`UPDATE deck_edit_leases SET holder_user_id=NULL, holder_client_id=NULL, lease_token=NULL, acquired_at=NULL, heartbeat_at=NULL, expires_at=NULL, takeover_request_id=NULL, takeover_user_id=NULL, takeover_client_id=NULL, takeover_lease_token=NULL, takeover_requested_at=NULL, takeover_deadline_at=NULL WHERE deck_id=?`)
      .run(input.deckId);
    return { state: "released" };
  });
}

export function assertActiveDeckEditLease(input: ActiveDeckLeaseInput, now = new Date()): void {
  validateDeckWrite(input);
  const row = getLeaseRow(input.deckId);
  if (!row || !row.holder_user_id || row.holder_user_id !== input.userId || row.holder_client_id !== input.clientId || row.lease_token !== input.leaseToken || row.generation !== input.generation || isExpired(row, now)) {
    throw new HttpError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
  }
}
