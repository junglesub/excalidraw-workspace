import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { getDb, resetDb } from "@/lib/db";
import { createUser } from "@/lib/users";
import { createSnapshotFromDoc, listVersions } from "@/lib/versions";
import { getDocumentRaw, getDocumentWithScene, updateScene } from "@/lib/documents";
import { emptyScene, type ExcalidrawScene } from "@/lib/types";
import {
  createBlankPage,
  createDeck,
  deletePage,
  deleteDeck,
  duplicatePage,
  getDeck,
  listDecks,
  renamePage,
  reorderPages,
} from "@/lib/decks";

describe("presentation decks", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("creates a deck with one blank document-backed page", () => {
    const owner = createUser("deck-owner", "pass123", "USER");

    const deck = createDeck(owner.id, "Episode 1", "16:9");

    expect(deck.title).toBe("Episode 1");
    expect(deck.aspectRatio).toBe("16:9");
    expect(deck.pages).toHaveLength(1);
    expect(deck.pages[0].title).toBe("Page 1");
    expect(getDocumentRaw(deck.pages[0].documentId)?.owner_id).toBe(owner.id);
    expect(listDecks(owner.id).map((item) => item.id)).toEqual([deck.id]);
  });

  it("rejects unsupported aspect ratios", () => {
    const owner = createUser("ratio-owner", "pass123", "USER");

    expect(() => createDeck(owner.id, "Bad", "4:3" as never)).toThrow(/aspect ratio/i);
  });

  it("adds, renames, reorders, and deletes pages while keeping positions contiguous", () => {
    const owner = createUser("page-owner", "pass123", "USER");
    const deck = createDeck(owner.id, "Deck", "9:16");
    const second = createBlankPage(deck.id, owner.id, "USER");
    const third = createBlankPage(deck.id, owner.id, "USER");

    renamePage(deck.id, second.id, "Middle", owner.id, "USER");
    reorderPages(deck.id, [third.id, deck.pages[0].id, second.id], owner.id, "USER");

    let current = getDeck(deck.id, owner.id, "USER");
    expect(current.pages.map((page) => [page.title, page.order])).toEqual([
      ["Page 3", 0],
      ["Page 1", 1],
      ["Middle", 2],
    ]);

    const deletedDocumentId = current.pages[1].documentId;
    deletePage(deck.id, current.pages[1].id, owner.id, "USER");
    current = getDeck(deck.id, owner.id, "USER");
    expect(current.pages.map((page) => page.order)).toEqual([0, 1]);
    expect(getDocumentRaw(deletedDocumentId)).toBeUndefined();
  });

  it("duplicates current scene and attachments without copying version history", () => {
    const owner = createUser("duplicate-owner", "pass123", "USER");
    const deck = createDeck(owner.id, "Deck", "16:9");
    const source = deck.pages[0];
    const fileId = "image_file_1";
    const bytes = Buffer.from("duplicate-image-bytes");
    const scene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "img", type: "image", fileId, isDeleted: false }],
      files: {
        [fileId]: {
          id: fileId,
          mimeType: "image/png",
          created: Date.now(),
          dataURL: `data:image/png;base64,${bytes.toString("base64")}`,
        },
      },
    };
    updateScene(source.documentId, scene, owner.id, "USER", false, { allowInlineDataUrl: true });
    createSnapshotFromDoc(source.documentId, owner.id);
    expect(listVersions(source.documentId)).toHaveLength(1);

    const copy = duplicatePage(deck.id, source.id, owner.id, "USER");

    expect(copy.title).toBe("Page 1 Copy");
    expect(listVersions(copy.documentId)).toHaveLength(0);
    const hydrated = getDocumentWithScene(copy.documentId, owner.id, "USER", false, { hydrate: true }).scene;
    expect(hydrated.elements).toEqual(scene.elements);
    expect((hydrated.files[fileId] as { dataURL?: string }).dataURL).toBe(
      `data:image/png;base64,${bytes.toString("base64")}`,
    );
    const attachmentCount = getDb()
      .prepare("SELECT COUNT(*) AS count FROM attachments WHERE document_id = ?")
      .get(copy.documentId) as { count: number };
    expect(attachmentCount.count).toBe(1);
  });

  it("deleting a deck removes every page backing document", () => {
    const owner = createUser("delete-deck-owner", "pass123", "USER");
    const deck = createDeck(owner.id, "Disposable", "16:9");
    const second = createBlankPage(deck.id, owner.id, "USER");
    const documentIds = [deck.pages[0].documentId, second.documentId];

    deleteDeck(deck.id, owner.id, "USER");

    expect(documentIds.map((id) => getDocumentRaw(id))).toEqual([undefined, undefined]);
  });

  it("prevents another user from reading or mutating a deck", () => {
    const owner = createUser("private-owner", "pass123", "USER");
    const stranger = createUser("private-stranger", "pass123", "USER");
    const deck = createDeck(owner.id, "Private", "16:9");

    expect(() => getDeck(deck.id, stranger.id, "USER")).toThrow(/access denied/i);
    expect(() => createBlankPage(deck.id, stranger.id, "USER")).toThrow(/access denied/i);
  });
});
