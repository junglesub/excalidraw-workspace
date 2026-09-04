import { ApiError } from "./client";
import type { EditLeaseCredentials, LeaseHolderSummary } from "./types";

export type DeckLeaseApiResult =
  | ({ state: "acquired"; deckId: string; acquiredAt: string; heartbeatAt: string; expiresAt: string } & EditLeaseCredentials)
  | { state: "held"; holder: LeaseHolderSummary }
  | { state: "takeover_pending"; holder: LeaseHolderSummary; requestId: string; requestedAt: string; deadlineAt: string }
  | { state: "takeover_in_progress"; holder: LeaseHolderSummary; requestId: string; deadlineAt: string }
  | { state: "released" }
  | { state: "transferred" };

interface AcquireInput {
  clientId: string;
  leaseToken: string;
  priorLeaseToken?: string;
  priorGeneration?: number;
}

async function requestDeckLease(
  deckId: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<DeckLeaseApiResult> {
  const response = await fetchFn(`/api/decks/${encodeURIComponent(deckId)}/lease`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as DeckLeaseApiResult & { error?: string; code?: string };
  if (!response.ok) {
    if (data.state === "held" || data.state === "takeover_in_progress") return data;
    throw new ApiError(response.status, data.error || `Deck lease request failed with HTTP ${response.status}`, data.code);
  }
  return data;
}

export function deckLeaseStorageKey(deckId: string, contextId: string): string {
  return `excalidraw_deck_lease_${deckId}_${contextId}`;
}

export function deckLeaseAttemptStorageKey(deckId: string, contextId: string): string {
  return `excalidraw_deck_lease_attempt_${deckId}_${contextId}`;
}

export function getOrCreateDeckLeaseAttemptToken(
  storage: Storage,
  deckId: string,
  contextId: string,
  createToken: () => string = () => crypto.randomUUID(),
): string {
  const key = deckLeaseAttemptStorageKey(deckId, contextId);
  try {
    const existing = storage.getItem(key);
    if (existing && existing.length <= 256) return existing;
    const created = createToken();
    storage.setItem(key, created);
    return created;
  } catch {
    return createToken();
  }
}

export function readStoredDeckLeaseCredentials(storage: Storage, deckId: string, contextId: string): Omit<EditLeaseCredentials, "clientId"> | null {
  try {
    const raw = storage.getItem(deckLeaseStorageKey(deckId, contextId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { leaseToken?: unknown; generation?: unknown };
    if (typeof parsed.leaseToken !== "string" || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) <= 0) return null;
    return { leaseToken: parsed.leaseToken, generation: Number(parsed.generation) };
  } catch {
    return null;
  }
}

export function storeDeckLeaseCredentials(storage: Storage, deckId: string, contextId: string, credentials: Omit<EditLeaseCredentials, "clientId">): void {
  storage.setItem(deckLeaseStorageKey(deckId, contextId), JSON.stringify(credentials));
}

export function clearStoredDeckLeaseCredentials(storage: Storage, deckId: string, contextId: string): void {
  storage.removeItem(deckLeaseStorageKey(deckId, contextId));
}

export function acquireDeckLease(deckId: string, input: AcquireInput, fetchFn?: typeof fetch) {
  return requestDeckLease(deckId, { action: "acquire", ...input }, fetchFn);
}

export function heartbeatDeckLease(deckId: string, credentials: EditLeaseCredentials, fetchFn?: typeof fetch) {
  return requestDeckLease(deckId, { action: "heartbeat", ...credentials }, fetchFn);
}

export function releaseDeckLease(deckId: string, credentials: EditLeaseCredentials, fetchFn?: typeof fetch) {
  return requestDeckLease(deckId, { action: "release", ...credentials }, fetchFn);
}

export function requestDeckTakeover(deckId: string, input: { clientId: string; leaseToken: string; requestId?: string }, fetchFn?: typeof fetch) {
  return requestDeckLease(deckId, { action: "request_takeover", ...input }, fetchFn);
}

export function pollDeckTakeover(deckId: string, input: { clientId: string; leaseToken: string; requestId: string }, fetchFn?: typeof fetch) {
  return requestDeckLease(deckId, { action: "poll_takeover", ...input }, fetchFn);
}
