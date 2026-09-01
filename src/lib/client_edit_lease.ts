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

async function leaseFetch(docId: string, body: Record<string, unknown>, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  const fetchImpl = fetchFn || (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);
  const base = getBase();
  const url = new URL(`/api/documents/${encodeURIComponent(docId)}/lease`, base);
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
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`;
    const code = data && typeof data === "object" && "code" in data && typeof (data as { code: unknown }).code === "string" ? String((data as { code: unknown }).code) : undefined;
    // For held and takeover_in_progress, server returns 409 with JSON body that includes holder info even on error.
    // If body contains state, return it as normal result instead of throwing? But spec says held returns 409.
    // For client transport, we want to surface held as throw with ApiError? However lease API tests expect held as 409 throw.
    // For caller convenience, if data contains state held/takeover_in_progress, we can throw ApiError but also include data.
    // Simpler: throw ApiError with code and the data's holder info can be parsed from error? But transport tests expect to get state held via thrown error's handling.
    // To make transport stateless and let caller decide, we throw ApiError. The caller can inspect status/code.
    // However for polling, we need to distinguish. We'll throw.
    throw new ApiError(res.status, msg, code);
  }
  return data as LeaseResponse;
}

// For cases where held is returned as 409, the caller may want the holder data. The fetch above throws.
// To still provide holder data, we could catch and return? But spec for transport: they send one HTTP request and return typed response.
// For 409 held, they should still return holder info via successful parsing. To support tests that check held via error body, we can handle 409 specially: if res.status===409 and data has state, return data as LeaseResponse instead of throwing.
// Let's adjust: if status 409 and data has state held/takeover_in_progress, return it.

async function leaseFetchWithHeld(docId: string, body: Record<string, unknown>, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  const fetchImpl = fetchFn || (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);
  const base = getBase();
  const url = new URL(`/api/documents/${encodeURIComponent(docId)}/lease`, base);
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

export function acquireLease(docId: string, identity: LeaseCandidate, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  return leaseFetchWithHeld(docId, { action: "acquire", clientId: identity.clientId, leaseToken: identity.leaseToken }, fetchFn);
}

export function heartbeatLease(docId: string, lease: EditLeaseCredentials, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  return leaseFetchWithHeld(docId, { action: "heartbeat", clientId: lease.clientId, leaseToken: lease.leaseToken, generation: lease.generation }, fetchFn);
}

export function requestTakeover(docId: string, candidate: LeaseCandidate & { requestId?: string }, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  const body: Record<string, unknown> = { action: "request_takeover", clientId: candidate.clientId, leaseToken: candidate.leaseToken };
  if (candidate.requestId) body.requestId = candidate.requestId;
  return leaseFetchWithHeld(docId, body, fetchFn);
}

export function pollTakeover(docId: string, request: TakeoverPoll, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  const body: Record<string, unknown> = { action: "poll_takeover", clientId: request.clientId, leaseToken: request.leaseToken, requestId: request.requestId };
  if (request.generation !== undefined) body.generation = request.generation;
  return leaseFetchWithHeld(docId, body, fetchFn);
}

export function releaseLease(docId: string, lease: EditLeaseCredentials, fetchFn?: typeof fetch): Promise<LeaseResponse> {
  return leaseFetchWithHeld(docId, { action: "release", clientId: lease.clientId, leaseToken: lease.leaseToken, generation: lease.generation }, fetchFn);
}

export function canMutateCanvas(mode: EditorLeaseMode): boolean {
  return mode === "active";
}

export function shouldReadLocalDraft(mode: EditorLeaseMode): boolean {
  return mode === "active";
}
