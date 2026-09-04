import { beforeEach, describe, expect, it } from "vitest";
import { POST as leaseRoute } from "@/app/api/decks/[id]/lease/route";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createDeck } from "@/lib/decks";
import { SESSION_COOKIE } from "@/lib/http";
import { createSession, createUser } from "@/lib/users";

describe("Deck lease API route", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  function request(deckId: string, token: string | undefined, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.cookie = `${SESSION_COOKIE}=${token}`;
    return new Request(`http://localhost/api/decks/${deckId}/lease`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("acquires, heartbeats, blocks a second context, and releases", async () => {
    const owner = createUser("deck-route-owner", "pass123", "USER");
    const deck = createDeck(owner.id, "Deck", "16:9");
    const session = createSession(owner.id);

    const acquired = await leaseRoute(request(deck.id, session.token, { action: "acquire", clientId: "tab-a", leaseToken: "token-a" }), { params: Promise.resolve({ id: deck.id }) });
    expect(acquired.status).toBe(200);
    const acquiredBody = await acquired.json();
    expect(acquiredBody.state).toBe("acquired");

    const held = await leaseRoute(request(deck.id, session.token, { action: "acquire", clientId: "tab-b", leaseToken: "token-b" }), { params: Promise.resolve({ id: deck.id }) });
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ state: "held", code: "EDIT_LEASE_HELD" });

    const heartbeat = await leaseRoute(request(deck.id, session.token, { action: "heartbeat", clientId: "tab-a", leaseToken: "token-a", generation: acquiredBody.generation }), { params: Promise.resolve({ id: deck.id }) });
    expect(heartbeat.status).toBe(200);
    expect((await heartbeat.json()).state).toBe("acquired");

    const released = await leaseRoute(request(deck.id, session.token, { action: "release", clientId: "tab-a", leaseToken: "token-a", generation: acquiredBody.generation }), { params: Promise.resolve({ id: deck.id }) });
    expect(released.status).toBe(200);
    expect((await released.json()).state).toBe("released");
  });

  it("rejects unauthenticated and malformed requests", async () => {
    const owner = createUser("deck-route-owner-2", "pass123", "USER");
    const deck = createDeck(owner.id, "Deck", "16:9");
    const unauth = await leaseRoute(request(deck.id, undefined, { action: "acquire", clientId: "tab", leaseToken: "token" }), { params: Promise.resolve({ id: deck.id }) });
    expect(unauth.status).toBe(401);
    const session = createSession(owner.id);
    const bad = await leaseRoute(request(deck.id, session.token, { action: "heartbeat", clientId: "tab", leaseToken: "token" }), { params: Promise.resolve({ id: deck.id }) });
    expect(bad.status).toBe(400);
  });
});
