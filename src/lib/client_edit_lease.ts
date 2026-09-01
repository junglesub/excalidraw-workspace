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

export function acquireLease(docId: string, identity: LeaseCandidate & { priorLeaseToken?: string; priorGeneration?: number }, fetchFn?: typeof fetch, adminMode?: boolean): Promise<LeaseResponse> {
  const body: Record<string, unknown> = { action: "acquire", clientId: identity.clientId, leaseToken: identity.leaseToken };
  if (identity.priorLeaseToken !== undefined && identity.priorGeneration !== undefined) {
    body.priorLeaseToken = identity.priorLeaseToken;
    body.priorGeneration = identity.priorGeneration;
  }
  return leaseFetchWithHeld(docId, body, fetchFn, adminMode);
}

// Per-browsing-context identity for same-context re-entry (non-secret only).
//
// Platform semantics (MDN Window.name): the name is a property of the browsing
// context itself. It survives same-tab reloads and same-origin navigations, modern
// browsers reset it on cross-domain loads and restore it when the original page
// returns, and a context opened via window.open/target starts as a new context whose
// name is only what the opener explicitly assigns (the editor never assigns opener
// names). A new page instance therefore finds the same context id, while a
// newly opened editor context starts empty and generates its own id.
// Never store tokens or credentials here; the id is not a secret.

export const EDITOR_CONTEXT_ID_PREFIX = "ecid:";
const EDITOR_CONTEXT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseEditorContextId(name: string): string | null {
  if (typeof name !== "string" || !name.startsWith(EDITOR_CONTEXT_ID_PREFIX)) return null;
  const id = name.slice(EDITOR_CONTEXT_ID_PREFIX.length);
  return EDITOR_CONTEXT_ID_PATTERN.test(id) ? id : null;
}

export function getEditorContextId(): string {
  if (typeof window !== "undefined") {
    const existing = parseEditorContextId(window.name);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.name = EDITOR_CONTEXT_ID_PREFIX + id;
    return id;
  }
  return "";
}

// Previous server-issued lease credentials for same-context re-entry proof, persisted
// in sessionStorage keyed by document + context id. sessionStorage survives reload in
// the same browsing context; a newly opened context (opener-created or duplicated)
// cannot present them under its own context id because the id differs.
export function leaseCredentialsKey(docId: string, contextId: string): string {
  return `excalidraw_lease_cred:${docId}:${contextId}`;
}

export interface StoredLeaseCredentials {
  leaseToken: string;
  generation: number;
}

export function readStoredLeaseCredentials(storage: Storage, docId: string, contextId: string): StoredLeaseCredentials | null {
  try {
    const raw = storage.getItem(leaseCredentialsKey(docId, contextId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { leaseToken?: unknown; generation?: unknown };
    if (typeof parsed.leaseToken !== "string" || parsed.leaseToken.length === 0 || parsed.leaseToken.length > 256) return null;
    if (typeof parsed.generation !== "number" || !Number.isSafeInteger(parsed.generation) || parsed.generation <= 0) return null;
    return { leaseToken: parsed.leaseToken, generation: parsed.generation };
  } catch {
    return null;
  }
}

export function storeLeaseCredentials(storage: Storage, docId: string, contextId: string, creds: StoredLeaseCredentials): void {
  try {
    storage.setItem(leaseCredentialsKey(docId, contextId), JSON.stringify(creds));
  } catch {
    // storage may be unavailable; re-entry proof is best-effort
  }
}

export function clearStoredLeaseCredentials(storage: Storage, docId: string, contextId: string | null, expected?: StoredLeaseCredentials): void {
  if (!contextId) return;
  // Compare-and-clear: only remove the stored value when it still exactly matches the caller's
  // credential (token AND generation). A same-context rotation stores the newer server-issued
  // credential under this same key, so a late callback from the previous page instance that was
  // fenced (e.g. to EDIT_LEASE_LOST) must never delete the newer credential. Without an expected
  // credential we cannot prove the stored value was issued to us, so we do not delete (safe).
  if (!expected) return;
  try {
    const stored = readStoredLeaseCredentials(storage, docId, contextId);
    if (!stored) return;
    if (stored.leaseToken !== expected.leaseToken || stored.generation !== expected.generation) return;
    storage.removeItem(leaseCredentialsKey(docId, contextId));
  } catch {
    // ignore
  }
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
