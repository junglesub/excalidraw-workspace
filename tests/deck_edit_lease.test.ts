import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { getDb, resetDb } from "@/lib/db";

describe("deck edit lease schema", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("creates a deck_edit_leases table", () => {
    expect(() => getDb().prepare("SELECT deck_id, generation FROM deck_edit_leases").all()).not.toThrow();
  });
});

import {
  acquireDeckEditLease,
  assertActiveDeckEditLease,
  heartbeatDeckEditLease,
  releaseDeckEditLease,
  requestDeckEditTakeover,
  pollDeckEditTakeover,
  TAKEOVER_TIMEOUT_MS,
} from "@/lib/deck_edit_lease";
import { createUser } from "@/lib/users";
import { createDeck } from "@/lib/decks";

describe("deck edit lease behavior", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("allows one holder and blocks another live browsing context, including the same user", () => {
    const user = createUser("deck-lease-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const first = acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab-a", leaseToken: "token-a" });
    expect(first.state).toBe("acquired");

    const second = acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab-b", leaseToken: "token-b" });
    expect(second.state).toBe("held");
  });

  it("rotates credentials for proven same-context re-entry and fences the old generation", () => {
    const user = createUser("deck-reentry-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const first = acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "same-tab", leaseToken: "old-token" });
    expect(first.state).toBe("acquired");
    if (first.state !== "acquired") throw new Error("expected acquired");

    const rotated = acquireDeckEditLease({
      deckId: deck.id,
      userId: user.id,
      role: "USER",
      clientId: "same-tab",
      leaseToken: "new-token",
      priorLeaseToken: first.leaseToken,
      priorGeneration: first.generation,
    });
    expect(rotated.state).toBe("acquired");
    if (rotated.state !== "acquired") throw new Error("expected acquired");
    expect(rotated.generation).toBe(first.generation + 1);
    expect(() => assertActiveDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: first.clientId, leaseToken: first.leaseToken, generation: first.generation })).toThrow(/lease was lost/i);
    expect(() => assertActiveDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: rotated.clientId, leaseToken: rotated.leaseToken, generation: rotated.generation })).not.toThrow();
  });

  it("heartbeats and releases an active Deck lease", () => {
    const user = createUser("deck-heartbeat-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const acquired = acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab", leaseToken: "token" });
    if (acquired.state !== "acquired") throw new Error("expected acquired");
    expect(heartbeatDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: acquired.clientId, leaseToken: acquired.leaseToken, generation: acquired.generation }).state).toBe("acquired");
    expect(releaseDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: acquired.clientId, leaseToken: acquired.leaseToken, generation: acquired.generation }).state).toBe("released");
    expect(() => assertActiveDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: acquired.clientId, leaseToken: acquired.leaseToken, generation: acquired.generation })).toThrow(/lease was lost/i);
  });

  it("supports takeover after the timeout and advances fencing generation", () => {
    const user = createUser("deck-takeover-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const t0 = new Date("2026-09-01T00:00:00.000Z");
    const first = acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab-a", leaseToken: "token-a" }, t0);
    if (first.state !== "acquired") throw new Error("expected acquired");
    const requested = requestDeckEditTakeover({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab-b", leaseToken: "token-b", requestId: "request-b" }, new Date(t0.getTime() + 1000));
    expect(requested.state).toBe("takeover_pending");
    const transferred = pollDeckEditTakeover({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab-b", leaseToken: "token-b", requestId: "request-b" }, new Date(t0.getTime() + 1000 + TAKEOVER_TIMEOUT_MS));
    expect(transferred.state).toBe("acquired");
    if (transferred.state !== "acquired") throw new Error("expected acquired");
    expect(transferred.generation).toBe(first.generation + 1);
  });
});

import { createSnapshotFromDoc, handleAutoSave, handleManualSave, resolveRecoveryConflict, restoreVersion } from "@/lib/versions";
import { acquireEditLease } from "@/lib/edit_lease";
import { getDocumentRaw } from "@/lib/documents";
import { createBlankPage } from "@/lib/decks";
import { emptyScene } from "@/lib/types";

describe("Deck lease Page save authorization", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("rejects standalone lease acquisition for a Deck backing document", () => {
    const user = createUser("cross-scope", "pass123", "USER");
    const deck = createDeck(user.id, "Deck");
    acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "deck-tab", leaseToken: "deck-token" });
    expect(() => acquireEditLease({ docId: deck.pages[0].documentId, userId: user.id, role: "USER", adminMode: false, clientId: "doc-tab", leaseToken: "doc-token" })).toThrow(/Deck/);
  });

  it("fences existing standalone credentials from saves, recovery and restore on a Deck page", () => {
    const user = createUser("legacy-cross-scope", "pass123", "USER");
    const deck = createDeck(user.id, "Deck");
    const docId = deck.pages[0].documentId;
    const snapshot = createSnapshotFromDoc(docId, user.id);
    const lease = { clientId: "old-tab", leaseToken: "old-token", generation: 1 };
    getDb().prepare(`INSERT INTO document_edit_leases
      (document_id, holder_user_id, holder_client_id, lease_token, generation, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(docId, user.id, lease.clientId, lease.leaseToken, lease.generation, new Date(Date.now() + 90_000).toISOString());
    expect(() => handleAutoSave(docId, user.id, "USER", false, emptyScene(), null, false, lease)).toThrow(/Deck/);
    expect(() => handleManualSave(docId, user.id, "USER", false, emptyScene(), null, lease)).toThrow(/Deck/);
    expect(() => resolveRecoveryConflict(docId, user.id, "USER", false, {
      choice: "client", preserveDiscarded: false, expectedServerUpdatedAt: getDocumentRaw(docId)!.updated_at, clientScene: emptyScene(),
    }, lease)).toThrow(/Deck/);
    expect(() => restoreVersion(docId, snapshot.id, user.id, "USER", false, lease)).toThrow(/Deck/);
  });

  it("allows a Page backing Document to save under its owning Deck lease", () => {
    const user = createUser("deck-save-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const lease = acquireDeckEditLease({ deckId: deck.id, userId: user.id, role: "USER", clientId: "tab", leaseToken: "deck-token" });
    if (lease.state !== "acquired") throw new Error("expected acquired");
    const result = handleAutoSave(
      deck.pages[0].documentId,
      user.id,
      "USER",
      false,
      { ...emptyScene(), elements: [{ id: "deck-save", type: "rectangle", isDeleted: false }] },
      null,
      false,
      { scope: "deck", deckId: deck.id, credentials: { clientId: lease.clientId, leaseToken: lease.leaseToken, generation: lease.generation } } as never,
    );
    expect(result.updatedAt).toBeTruthy();
  });

  it("does not let a Deck lease save another Deck's Page", () => {
    const user = createUser("deck-save-boundary", "pass123", "USER");
    const first = createDeck(user.id, "First", "16:9");
    const second = createDeck(user.id, "Second", "16:9");
    createBlankPage(first.id, user.id, "USER");
    const lease = acquireDeckEditLease({ deckId: first.id, userId: user.id, role: "USER", clientId: "tab", leaseToken: "deck-token" });
    if (lease.state !== "acquired") throw new Error("expected acquired");
    expect(() => handleAutoSave(
      second.pages[0].documentId,
      user.id,
      "USER",
      false,
      emptyScene(),
      null,
      false,
      { scope: "deck", deckId: first.id, credentials: { clientId: lease.clientId, leaseToken: lease.leaseToken, generation: lease.generation } } as never,
    )).toThrow();
  });
});
