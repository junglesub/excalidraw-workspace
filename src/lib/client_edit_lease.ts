"use client";

import type { EditLeaseCredentials } from "./types";
import { ApiError } from "./client";

export type EditorLeaseMode = "viewer" | "acquiring" | "blocked" | "active" | "handoff" | "readonly" | "lost";

export interface LeaseHolderSummaryWire {
  username: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LeaseCandidate {
  clientId: string;
  leaseToken: string;
}

export interface LeaseResponseAcquired {
  state: "acquired";
  generation: number;
  clientId: string;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface LeaseResponseHeld {
  state: "held";
  holder: LeaseHolderSummaryWire;
  code?: string;
}

export interface LeaseResponseTakeoverPending {
  state: "takeover_pending";
  holder: LeaseHolderSummaryWire;
  requestId: string;
  requestedAt: string;
  deadlineAt: string;
}

export interface LeaseResponseTakeoverInProgress {
  state: "takeover_in_progress";
  holder: LeaseHolderSummaryWire;
  requestId: string;
  deadlineAt: string;
}

export type LeaseResponse =
  | LeaseResponseAcquired
  | LeaseResponseHeld
  | LeaseResponseTakeoverPending
  | LeaseResponseTakeoverInProgress;

export interface TakeoverPoll {
  clientId: string;
  leaseToken: string;
  requestId: string;
  generation?: number;
}

export const LEASE_CLIENT_ID_KEY = "excalidraw_client_id";

export function getLeaseClientId(storage: Storage): string {
  const existing = storage.getItem(LEASE_CLIENT_ID_KEY);
  if (existing && existing.length > 0 && existing.length <= 256) return existing;
  const newId = crypto.randomUUID();
  storage.setItem(LEASE_CLIENT_ID_KEY, newId);
  return newId;
}

function getBase(): string {
  if (typeof window !== "undefined" && window.location && window.location.origin) return window.location.origin;
  return "http://localhost";
}

async function leaseFetchWithHeld(docId: string, body: Record<string, unknown>, fetchFn?: typeof fetch, adminMode?: boolean): Promise<LeaseResponse> {
  const fetchImpl = fetchFn || (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);
  const base = getBase();
  const url = new URL(`/api/documents/${encodeURIComponent(docId)}/lease`, base);
  if (adminMode) url.searchParams.set("adminMode", "1");
  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (data && typeof data === "object" && data !== null && "state" in data) {
      const state = (data as { state: string }).state;
      if (state === "held" || state === "takeover_in_progress") {
        return data as LeaseResponse;
      }
    }
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`;
    const code = data && typeof data === "object" && "code" in data && typeof (data as { code: unknown }).code === "string" ? String((data as { code: unknown }).code) : undefined;
    throw new ApiError(res.status, msg, code);
  }
  return data as LeaseResponse;
}

export function acquireLease(docId: string, identity: LeaseCandidate, fetchFn?: typeof fetch, adminMode?: boolean, options?: { reentry?: boolean }): Promise<LeaseResponse> {
  const body: Record<string, unknown> = { action: "acquire", clientId: identity.clientId, leaseToken: identity.leaseToken };
  if (options?.reentry === true) body.reentry = true;
  return leaseFetchWithHeld(docId, body, fetchFn, adminMode);
}

// Web Locks-based per-context liveness. A lock is held by the live editor document,
// released when that document unloads, and is never copied to opener-created windows
// or duplicated tabs (unlike sessionStorage, which MDN documents as copied to a page
// with an opener). This gives the re-entry decision a truly per-browsing-context
// identity: survive reload/navigation, not copied to a newly opened editor context.

export const LEASE_HOLD_LOCK_PREFIX = "edit-lease-hold:";

export function leaseHoldLockName(docId: string, clientId: string): string {
  return `${LEASE_HOLD_LOCK_PREFIX}${docId}:${clientId}`;
}

interface LockManagerLike {
  request: (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void>) => Promise<unknown>;
}

function getLockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks ?? null;
}

export async function probeReentryLock(docId: string, clientId: string, options?: { attempts?: number; delayMs?: number; locks?: LockManagerLike | null }): Promise<boolean> {
  const locks = options?.locks !== undefined ? options.locks : getLockManager();
  if (!locks) return false;
  const attempts = options?.attempts ?? 4;
  const delayMs = options?.delayMs ?? 150;
  const name = leaseHoldLockName(docId, clientId);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let granted = false;
    try {
      await locks.request(name, { ifAvailable: true }, async (lock) => {
        granted = lock != null;
      });
    } catch {
      return false;
    }
    if (granted) return true;
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

export function requestLeaseHold(docId: string, clientId: string, onHeld: (release: () => void) => void, locksOverride?: LockManagerLike | null): void {
  const locks = locksOverride !== undefined ? locksOverride : getLockManager();
  if (!locks) return;
  void locks
    .request(leaseHoldLockName(docId, clientId), { ifAvailable: true }, () => new Promise<void>((resolve) => { onHeld(resolve); }))
    .catch(() => {});
}


export function heartbeatLease(docId: string, lease: EditLeaseCredentials, fetchFn?: typeof fetch, adminMode?: boolean): Promise<LeaseResponse> {
  return leaseFetchWithHeld(docId, { action: "heartbeat", clientId: lease.clientId, leaseToken: lease.leaseToken, generation: lease.generation }, fetchFn, adminMode);
}

export function requestTakeover(docId: string, candidate: LeaseCandidate & { requestId?: string }, fetchFn?: typeof fetch, adminMode?: boolean): Promise<LeaseResponse> {
  const body: Record<string, unknown> = { action: "request_takeover", clientId: candidate.clientId, leaseToken: candidate.leaseToken };
  if (candidate.requestId) body.requestId = candidate.requestId;
  return leaseFetchWithHeld(docId, body, fetchFn, adminMode);
}

export function pollTakeover(docId: string, request: TakeoverPoll, fetchFn?: typeof fetch, adminMode?: boolean): Promise<LeaseResponse> {
  const body: Record<string, unknown> = { action: "poll_takeover", clientId: request.clientId, leaseToken: request.leaseToken, requestId: request.requestId };
  if (request.generation !== undefined) body.generation = request.generation;
  return leaseFetchWithHeld(docId, body, fetchFn, adminMode);
}

export function releaseLease(docId: string, lease: EditLeaseCredentials, fetchFn?: typeof fetch, adminMode?: boolean): Promise<LeaseResponse> {
  return leaseFetchWithHeld(docId, { action: "release", clientId: lease.clientId, leaseToken: lease.leaseToken, generation: lease.generation }, fetchFn, adminMode);
}

export function canMutateCanvas(mode: EditorLeaseMode): boolean {
  return mode === "active";
}

export function shouldReadLocalDraft(mode: EditorLeaseMode): boolean {
  return mode === "active";
}

export async function waitForNoSaving(isSavingRef: { current: boolean }, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (isSavingRef.current) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for saving to finish");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function shouldRecoverHandoffToActive(currentMode: EditorLeaseMode, heartbeatState: string): boolean {
  return currentMode === "handoff" && heartbeatState === "acquired";
}

export function shouldSkipHandoffForRestore(isRestoring: boolean, heartbeatState: string): boolean {
  return isRestoring && heartbeatState === "takeover_pending";
}

export function credentialKey(creds: EditLeaseCredentials): string {
  return JSON.stringify([creds.clientId, creds.leaseToken, creds.generation]);
}

export function dispatchRelease(url: string, payload: string, released: Set<string>, key: string): boolean {
  if (released.has(key)) return false;
  let dispatched = false;
  try {
    if (typeof navigator !== "undefined" && typeof (navigator as unknown as { sendBeacon?: (url: string, data: Blob) => boolean }).sendBeacon === "function") {
      try {
        const ok = (navigator as unknown as { sendBeacon: (url: string, data: Blob) => boolean }).sendBeacon(url, new Blob([payload], { type: "application/json" }));
        if (ok) dispatched = true;
        else throw new Error("beacon rejected");
      } catch {
        fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, credentials: "include", keepalive: true } as RequestInit);
        dispatched = true;
      }
    } else {
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, credentials: "include", keepalive: true } as RequestInit);
      dispatched = true;
    }
  } catch {}
  if (dispatched) released.add(key);
  return dispatched;
}
