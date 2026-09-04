import { describe, expect, it, vi } from "vitest";
import {
  acquireDeckLease,
  deckLeaseStorageKey,
  readStoredDeckLeaseCredentials,
  storeDeckLeaseCredentials,
} from "@/lib/client_deck_edit_lease";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("client Deck edit lease", () => {
  it("stores credentials by Deck and browsing context", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    expect(deckLeaseStorageKey("deck-1", "ctx-1")).not.toBe(deckLeaseStorageKey("deck-1", "ctx-2"));
    storeDeckLeaseCredentials(storage, "deck-1", "ctx-1", { leaseToken: "token", generation: 3 });
    expect(readStoredDeckLeaseCredentials(storage, "deck-1", "ctx-1")).toEqual({ leaseToken: "token", generation: 3 });
  });

  it("acquires from the Deck lease route", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ action: "acquire", clientId: "ctx", leaseToken: "token" });
      return new Response(JSON.stringify({ state: "acquired", deckId: "deck-1", clientId: "ctx", leaseToken: "token", generation: 4, acquiredAt: "a", heartbeatAt: "h", expiresAt: "e" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await acquireDeckLease("deck-1", { clientId: "ctx", leaseToken: "token" }, fetchFn);
    expect(result).toMatchObject({ state: "acquired", generation: 4 });
  });
});

it("reuses one pending acquire token before the server returns credentials", async () => {
  const { getOrCreateDeckLeaseAttemptToken } = await import("@/lib/client_deck_edit_lease");
  const storage = new MemoryStorage() as unknown as Storage;
  const first = getOrCreateDeckLeaseAttemptToken(storage, "deck-1", "ctx-1", () => "pending-token");
  const second = getOrCreateDeckLeaseAttemptToken(storage, "deck-1", "ctx-1", () => "different-token");
  expect(first).toBe("pending-token");
  expect(second).toBe("pending-token");
});
