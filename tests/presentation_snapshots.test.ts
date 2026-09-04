import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createUser } from "@/lib/users";
import { createDeck, createBlankPage, deletePage, getDeck } from "@/lib/decks";
import { getDocumentWithScene, updateScene } from "@/lib/documents";
import { emptyScene, type ExcalidrawScene } from "@/lib/types";
import { getVersion } from "@/lib/versions";
import { acquireEditLease } from "@/lib/edit_lease";
import {
  createNamedSnapshot,
  deleteNamedSnapshot,
  getActiveRecordingBaseline,
  listNamedSnapshots,
  listRecordingBaselines,
  resetRecordingBaseline,
  setRecordingBaseline,
} from "@/lib/presentation_snapshots";

function sceneWith(id: string): ExcalidrawScene {
  return { ...emptyScene(), elements: [{ id, type: "rectangle", isDeleted: false }] };
}

function sceneIds(documentId: string, userId: string): string[] {
  const scene = getDocumentWithScene(documentId, userId, "USER").scene;
  return (scene.elements as Array<{ id: string }>).map((element) => element.id);
}

describe("presentation snapshots and recording baselines", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("creates and deletes a permanent named snapshot for a page", () => {
    const user = createUser("named-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const page = deck.pages[0];
    updateScene(page.documentId, sceneWith("clean"), user.id, "USER");

    const named = createNamedSnapshot(deck.id, page.id, "Clean", user.id, "USER");

    expect(listNamedSnapshots(deck.id, page.id, user.id, "USER").map((item) => item.name)).toEqual(["Clean"]);
    expect(getVersion(named.snapshotId)?.is_pinned).toBe(1);

    deleteNamedSnapshot(deck.id, page.id, named.id, user.id, "USER");
    expect(listNamedSnapshots(deck.id, page.id, user.id, "USER")).toHaveLength(0);
    expect(getVersion(named.snapshotId)?.is_pinned).toBe(0);
  });

  it("creates a baseline for every current page and preserves previous baselines", () => {
    const user = createUser("baseline-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    createBlankPage(deck.id, user.id, "USER");

    const first = setRecordingBaseline(deck.id, user.id, "USER");
    const second = setRecordingBaseline(deck.id, user.id, "USER");

    expect(first.pages).toHaveLength(2);
    expect(second.pages).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
    expect(getActiveRecordingBaseline(deck.id, user.id, "USER")?.id).toBe(second.id);
    expect(listRecordingBaselines(deck.id, user.id, "USER").map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it("reset all restores baseline pages and leaves pages created afterward in place", () => {
    const user = createUser("reset-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const second = createBlankPage(deck.id, user.id, "USER");
    const before = getDeck(deck.id, user.id, "USER");
    updateScene(before.pages[0].documentId, sceneWith("p1-baseline"), user.id, "USER");
    updateScene(second.documentId, sceneWith("p2-baseline"), user.id, "USER");
    setRecordingBaseline(deck.id, user.id, "USER");

    updateScene(before.pages[0].documentId, sceneWith("p1-annotated"), user.id, "USER");
    updateScene(second.documentId, sceneWith("p2-annotated"), user.id, "USER");
    const later = createBlankPage(deck.id, user.id, "USER");
    updateScene(later.documentId, sceneWith("later-page"), user.id, "USER");

    const result = resetRecordingBaseline(deck.id, { scope: "all" }, user.id, "USER");

    expect(result.restoredPageIds).toHaveLength(2);
    expect(result.skippedPageIds).toEqual([]);
    expect(sceneIds(before.pages[0].documentId, user.id)).toEqual(["p1-baseline"]);
    expect(sceneIds(second.documentId, user.id)).toEqual(["p2-baseline"]);
    expect(sceneIds(later.documentId, user.id)).toEqual(["later-page"]);
    expect(getDeck(deck.id, user.id, "USER").pages.some((page) => page.id === later.id)).toBe(true);
  });

  it("reset current restores only the selected baseline page", () => {
    const user = createUser("current-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const second = createBlankPage(deck.id, user.id, "USER");
    const first = getDeck(deck.id, user.id, "USER").pages[0];
    updateScene(first.documentId, sceneWith("one"), user.id, "USER");
    updateScene(second.documentId, sceneWith("two"), user.id, "USER");
    setRecordingBaseline(deck.id, user.id, "USER");
    updateScene(first.documentId, sceneWith("one-edit"), user.id, "USER");
    updateScene(second.documentId, sceneWith("two-edit"), user.id, "USER");

    resetRecordingBaseline(deck.id, { scope: "current", pageId: first.id }, user.id, "USER");

    expect(sceneIds(first.documentId, user.id)).toEqual(["one"]);
    expect(sceneIds(second.documentId, user.id)).toEqual(["two-edit"]);
  });

  it("does not recreate deleted baseline pages and reports them as skipped", () => {
    const user = createUser("deleted-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const second = createBlankPage(deck.id, user.id, "USER");
    setRecordingBaseline(deck.id, user.id, "USER");
    deletePage(deck.id, second.id, user.id, "USER");

    const result = resetRecordingBaseline(deck.id, { scope: "all" }, user.id, "USER");

    expect(result.skippedPageIds).toEqual([second.id]);
    expect(getDeck(deck.id, user.id, "USER").pages).toHaveLength(1);
  });

  it("rejects reset before changing any page when a target document has an active edit lease", () => {
    const user = createUser("lease-owner", "pass123", "USER");
    const deck = createDeck(user.id, "Deck", "16:9");
    const page = deck.pages[0];
    updateScene(page.documentId, sceneWith("baseline"), user.id, "USER");
    setRecordingBaseline(deck.id, user.id, "USER");
    updateScene(page.documentId, sceneWith("edited"), user.id, "USER");
    const lease = acquireEditLease({
      docId: page.documentId,
      userId: user.id,
      role: "USER",
      adminMode: false,
      clientId: "editor-client",
      leaseToken: "lease-token",
    });
    expect(lease.state).toBe("acquired");

    expect(() => resetRecordingBaseline(deck.id, { scope: "all" }, user.id, "USER")).toThrow(/active edit lease/i);
    expect(sceneIds(page.documentId, user.id)).toEqual(["edited"]);
  });
});
