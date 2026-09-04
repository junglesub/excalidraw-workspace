import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createSession, createUser } from "@/lib/users";
import { SESSION_COOKIE } from "@/lib/http";
import { GET as listDecksRoute, POST as createDeckRoute } from "@/app/api/decks/route";
import {
  GET as getDeckRoute,
  PATCH as patchDeckRoute,
} from "@/app/api/decks/[id]/route";
import { POST as pageCollectionRoute } from "@/app/api/decks/[id]/pages/route";
import {
  DELETE as deletePageRoute,
  PATCH as patchPageRoute,
} from "@/app/api/decks/[id]/pages/[pageId]/route";
import { POST as reorderRoute } from "@/app/api/decks/[id]/pages/reorder/route";

function request(url: string, token?: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

describe("deck routes", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("creates, lists, reads, and updates a deck for the authenticated owner", async () => {
    const owner = createUser("route-owner", "pass123", "USER");
    const token = createSession(owner.id).token;

    const createRes = await createDeckRoute(
      request("http://localhost/api/decks", token, {
        method: "POST",
        body: JSON.stringify({ title: "Recording", aspectRatio: "9:16" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const deckId = created.deck.id as string;
    expect(created.deck.pages).toHaveLength(1);

    const listRes = await listDecksRoute(request("http://localhost/api/decks", token));
    expect((await listRes.json()).decks).toHaveLength(1);

    const patchRes = await patchDeckRoute(
      request(`http://localhost/api/decks/${deckId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Recording v2", aspectRatio: "16:9" }),
      }),
      { params: Promise.resolve({ id: deckId }) },
    );
    const patched = await patchRes.json();
    expect(patched.deck.title).toBe("Recording v2");
    expect(patched.deck.aspectRatio).toBe("16:9");

    const getRes = await getDeckRoute(request(`http://localhost/api/decks/${deckId}`, token), {
      params: Promise.resolve({ id: deckId }),
    });
    expect(getRes.status).toBe(200);
  });

  it("supports page create, rename, reorder, duplicate, and delete", async () => {
    const owner = createUser("page-route-owner", "pass123", "USER");
    const token = createSession(owner.id).token;
    const createRes = await createDeckRoute(
      request("http://localhost/api/decks", token, {
        method: "POST",
        body: JSON.stringify({ title: "Deck", aspectRatio: "16:9" }),
      }),
    );
    const deck = (await createRes.json()).deck;
    const first = deck.pages[0];

    const blankRes = await pageCollectionRoute(
      request(`http://localhost/api/decks/${deck.id}/pages`, token, {
        method: "POST",
        body: JSON.stringify({ action: "blank" }),
      }),
      { params: Promise.resolve({ id: deck.id }) },
    );
    const blankBody = await blankRes.json();
    const second = blankBody.page;

    const renameRes = await patchPageRoute(
      request(`http://localhost/api/decks/${deck.id}/pages/${second.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ title: "Second" }),
      }),
      { params: Promise.resolve({ id: deck.id, pageId: second.id }) },
    );
    expect((await renameRes.json()).page.title).toBe("Second");

    const duplicateRes = await pageCollectionRoute(
      request(`http://localhost/api/decks/${deck.id}/pages`, token, {
        method: "POST",
        body: JSON.stringify({ action: "duplicate", pageId: first.id }),
      }),
      { params: Promise.resolve({ id: deck.id }) },
    );
    const duplicateBody = await duplicateRes.json();
    expect(duplicateBody.deck.pages).toHaveLength(3);

    const ids = duplicateBody.deck.pages.map((page: { id: string }) => page.id).reverse();
    const reorderRes = await reorderRoute(
      request(`http://localhost/api/decks/${deck.id}/pages/reorder`, token, {
        method: "POST",
        body: JSON.stringify({ pageIds: ids }),
      }),
      { params: Promise.resolve({ id: deck.id }) },
    );
    expect((await reorderRes.json()).deck.pages.map((page: { id: string }) => page.id)).toEqual(ids);

    const deleteRes = await deletePageRoute(
      request(`http://localhost/api/decks/${deck.id}/pages/${second.id}`, token, { method: "DELETE" }),
      { params: Promise.resolve({ id: deck.id, pageId: second.id }) },
    );
    expect((await deleteRes.json()).deck.pages).toHaveLength(2);
  });

  it("rejects unauthenticated and non-owner access", async () => {
    const owner = createUser("secure-owner", "pass123", "USER");
    const stranger = createUser("secure-stranger", "pass123", "USER");
    const ownerToken = createSession(owner.id).token;
    const strangerToken = createSession(stranger.id).token;
    const createRes = await createDeckRoute(
      request("http://localhost/api/decks", ownerToken, {
        method: "POST",
        body: JSON.stringify({ title: "Private", aspectRatio: "16:9" }),
      }),
    );
    const deck = (await createRes.json()).deck;

    const anonymous = await listDecksRoute(request("http://localhost/api/decks"));
    expect(anonymous.status).toBe(401);

    const forbidden = await getDeckRoute(request(`http://localhost/api/decks/${deck.id}`, strangerToken), {
      params: Promise.resolve({ id: deck.id }),
    });
    expect(forbidden.status).toBe(403);
  });
});
