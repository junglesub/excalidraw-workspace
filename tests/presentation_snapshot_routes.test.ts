import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createSession, createUser } from "@/lib/users";
import { SESSION_COOKIE } from "@/lib/http";
import { createDeck } from "@/lib/decks";
import { acquireDeckEditLease } from "@/lib/deck_edit_lease";
import {
  GET as baselineGet,
  POST as baselinePost,
} from "@/app/api/decks/[id]/baseline/route";
import { POST as baselineReset } from "@/app/api/decks/[id]/baseline/reset/route";
import {
  GET as snapshotList,
  POST as snapshotCreate,
} from "@/app/api/decks/[id]/pages/[pageId]/snapshots/route";
import { DELETE as snapshotDelete } from "@/app/api/decks/[id]/pages/[pageId]/snapshots/[snapshotId]/route";


function acquireDeckCredentials(deckId: string, userId: string) {
  const result = acquireDeckEditLease({
    deckId,
    userId,
    role: "USER",
    clientId: `test-${deckId}`,
    leaseToken: `token-${deckId}`,
  });
  if (result.state !== "acquired") throw new Error("expected Deck lease");
  return { clientId: result.clientId, leaseToken: result.leaseToken, generation: result.generation };
}

function req(url: string, token?: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

describe("presentation snapshot routes", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("sets and reads the active recording baseline", async () => {
    const user = createUser("baseline-route", "pass123", "USER");
    const token = createSession(user.id).token;
    const deck = createDeck(user.id, "Deck", "16:9");
    const deckLease = acquireDeckCredentials(deck.id, user.id);

    const setRes = await baselinePost(req(`http://localhost/api/decks/${deck.id}/baseline`, token, {
      method: "POST",
      body: JSON.stringify({ deckLease }),
    }), {
      params: Promise.resolve({ id: deck.id }),
    });
    expect(setRes.status).toBe(201);
    const baseline = (await setRes.json()).baseline;
    expect(baseline.pages).toHaveLength(1);

    const getRes = await baselineGet(req(`http://localhost/api/decks/${deck.id}/baseline`, token), {
      params: Promise.resolve({ id: deck.id }),
    });
    expect((await getRes.json()).baseline.id).toBe(baseline.id);
  });

  it("creates, lists, and deletes named snapshots", async () => {
    const user = createUser("snapshot-route", "pass123", "USER");
    const token = createSession(user.id).token;
    const deck = createDeck(user.id, "Deck", "16:9");
    const page = deck.pages[0];
    const deckLease = acquireDeckCredentials(deck.id, user.id);

    const createRes = await snapshotCreate(
      req(`http://localhost/api/decks/${deck.id}/pages/${page.id}/snapshots`, token, {
        method: "POST",
        body: JSON.stringify({ name: "Clean", deckLease }),
      }),
      { params: Promise.resolve({ id: deck.id, pageId: page.id }) },
    );
    expect(createRes.status).toBe(201);
    const snapshot = (await createRes.json()).snapshot;

    const listRes = await snapshotList(req(`http://localhost/api/decks/${deck.id}/pages/${page.id}/snapshots`, token), {
      params: Promise.resolve({ id: deck.id, pageId: page.id }),
    });
    expect((await listRes.json()).snapshots.map((item: { name: string }) => item.name)).toEqual(["Clean"]);

    const deleteRes = await snapshotDelete(
      req(`http://localhost/api/decks/${deck.id}/pages/${page.id}/snapshots/${snapshot.id}`, token, {
        method: "DELETE",
        body: JSON.stringify({ deckLease }),
      }),
      { params: Promise.resolve({ id: deck.id, pageId: page.id, snapshotId: snapshot.id }) },
    );
    expect(deleteRes.status).toBe(200);
  });

  it("resets current page through the baseline route", async () => {
    const user = createUser("reset-route", "pass123", "USER");
    const token = createSession(user.id).token;
    const deck = createDeck(user.id, "Deck", "16:9");
    const page = deck.pages[0];
    const deckLease = acquireDeckCredentials(deck.id, user.id);
    await baselinePost(req(`http://localhost/api/decks/${deck.id}/baseline`, token, {
      method: "POST",
      body: JSON.stringify({ deckLease }),
    }), {
      params: Promise.resolve({ id: deck.id }),
    });

    const resetRes = await baselineReset(
      req(`http://localhost/api/decks/${deck.id}/baseline/reset`, token, {
        method: "POST",
        body: JSON.stringify({ scope: "current", pageId: page.id, deckLease }),
      }),
      { params: Promise.resolve({ id: deck.id }) },
    );
    expect(resetRes.status).toBe(200);
    expect((await resetRes.json()).result.restoredPageIds).toEqual([page.id]);
  });

  it("rejects unauthenticated baseline access", async () => {
    const user = createUser("anon-route", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const res = await baselineGet(req(`http://localhost/api/decks/${deck.id}/baseline`), {
      params: Promise.resolve({ id: deck.id }),
    });
    expect(res.status).toBe(401);
  });
});

it("requires the active Deck lease for recording baseline mutations", async () => {
  const user = createUser("baseline-lease-required", "pass123", "USER");
  const token = createSession(user.id).token;
  const deck = createDeck(user.id, "Deck", "16:9");
  const res = await baselinePost(req(`http://localhost/api/decks/${deck.id}/baseline`, token, {
    method: "POST",
    body: JSON.stringify({}),
  }), { params: Promise.resolve({ id: deck.id }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: expect.stringMatching(/Deck lease/i) });
});
