import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { resetDb, getDb, initializeSchema } from "@/lib/db";
import { createUser, createSession } from "@/lib/users";
import {
  createDocument,
  documentToMeta,
  getDocumentRaw,
  restoreDocument,
  softDelete,
  transferOwnership,
} from "@/lib/documents";
import { createDeck, createBlankPage, getDeck } from "@/lib/decks";
import {
  createFolder,
  deleteFolder,
  FolderError,
  getFolderBreadcrumbs,
  listAllUserFolders,
  listFolders,
  moveDeckToFolder,
  moveDocumentToFolder,
  moveFolder,
  renameFolder,
} from "@/lib/folders";
import { emptyScene } from "@/lib/types";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

describe("Workspace Folders", () => {
  beforeEach(() => {
    resetDb();
  });

  it("creates nested folders, validates names, and allows duplicate names", () => {
    const alice = createUser("alice", "password123");

    expect(() => createFolder(alice.id, "   ")).toThrow(FolderError);
    expect(() => createFolder(alice.id, "a".repeat(101))).toThrow(FolderError);

    const root1 = createFolder(alice.id, "  Projects  ", null);
    const root2 = createFolder(alice.id, "Projects", null);
    expect(root1.name).toBe("Projects");
    expect(root2.name).toBe("Projects");
    expect(root1.id).not.toBe(root2.id);

    const child = createFolder(alice.id, "2026", root1.id);
    const grandchild = createFolder(alice.id, "Q4", child.id);

    expect(listFolders(alice.id, null).map((f) => f.id)).toContain(root1.id);
    expect(listFolders(alice.id, root1.id).map((f) => f.id)).toEqual([child.id]);
    expect(getFolderBreadcrumbs(alice.id, grandchild.id).map((f) => f.name)).toEqual([
      "Projects",
      "2026",
      "Q4",
    ]);

    const renamed = renameFolder(alice.id, grandchild.id, "  Q4 Final  ");
    expect(renamed.name).toBe("Q4 Final");
  });

  it("moves folders, documents, and decks, and rejects cycles", () => {
    const alice = createUser("alice", "password123");
    const f1 = createFolder(alice.id, "F1", null);
    const f2 = createFolder(alice.id, "F2", f1.id);
    const f3 = createFolder(alice.id, "F3", f2.id);

    expect(() => moveFolder(alice.id, f1.id, f1.id)).toThrow("itself");
    expect(() => moveFolder(alice.id, f1.id, f3.id)).toThrow("descendant");

    const moved = moveFolder(alice.id, f3.id, null);
    expect(moved.parent_id).toBeNull();

    const doc = createDocument(alice.id, emptyScene(), "Doc 1", f1.id);
    expect(doc.folder_id).toBe(f1.id);
    moveDocumentToFolder(alice.id, doc.id, f2.id);
    expect(getDocumentRaw(doc.id)?.folder_id).toBe(f2.id);

    const deck = createDeck(alice.id, "Deck 1", "16:9", f1.id);
    expect(deck.folderId).toBe(f1.id);
    moveDeckToFolder(alice.id, deck.id, null);
    expect(getDeck(deck.id, alice.id, "USER").folderId).toBeNull();
  });

  it("enforces cross-user isolation", () => {
    const alice = createUser("alice", "password123");
    const bob = createUser("bob", "password123");

    const aliceFolder = createFolder(alice.id, "Alice Secret", null);
    const bobDoc = createDocument(bob.id, emptyScene(), "Bob Doc", null);

    expect(listAllUserFolders(bob.id)).toEqual([]);
    expect(() => renameFolder(bob.id, aliceFolder.id, "Hacked")).toThrow(FolderError);
    expect(() => deleteFolder(bob.id, aliceFolder.id)).toThrow(FolderError);
    expect(() => createFolder(bob.id, "Sub", aliceFolder.id)).toThrow(FolderError);
    expect(() => createDocument(bob.id, emptyScene(), "Bad", aliceFolder.id)).toThrow(FolderError);
    expect(() => createDeck(bob.id, "Bad Deck", "16:9", aliceFolder.id)).toThrow(FolderError);
    expect(() => moveDocumentToFolder(bob.id, bobDoc.id, aliceFolder.id)).toThrow(FolderError);
    expect(() => moveDocumentToFolder(alice.id, bobDoc.id, aliceFolder.id)).toThrow(FolderError);
  });

  it("deletes populated folder without content loss and reparents trashed docs", () => {
    const alice = createUser("alice", "password123");
    const parent = createFolder(alice.id, "Parent", null);
    const target = createFolder(alice.id, "Target", parent.id);
    const childFolder = createFolder(alice.id, "Child", target.id);
    const doc = createDocument(alice.id, emptyScene(), "Active Doc", target.id);
    const trashedDoc = createDocument(alice.id, emptyScene(), "Trashed Doc", target.id);
    softDelete(trashedDoc.id, alice.id, "USER");
    const deck = createDeck(alice.id, "Deck", "16:9", target.id);

    const res = deleteFolder(alice.id, target.id);
    expect(res.reparentedTo).toBe(parent.id);

    expect(listFolders(alice.id, parent.id).map((f) => f.id)).toEqual([childFolder.id]);
    expect(getDocumentRaw(doc.id)?.folder_id).toBe(parent.id);
    expect(getDocumentRaw(trashedDoc.id)?.folder_id).toBe(parent.id);
    expect(getDeck(deck.id, alice.id, "USER").folderId).toBe(parent.id);

    restoreDocument(trashedDoc.id, alice.id, "USER");
    expect(getDocumentRaw(trashedDoc.id)?.folder_id).toBe(parent.id);
  });

  it("rejects moving Deck backing documents independently", () => {
    const alice = createUser("alice", "password123");
    const folder = createFolder(alice.id, "F", null);
    const deck = createDeck(alice.id, "Deck", "16:9", null);
    const backingDocId = deck.pages[0].documentId;

    expect(() => moveDocumentToFolder(alice.id, backingDocId, folder.id)).toThrow(
      "Deck page backing documents cannot be moved independently",
    );
  });

  it("clears folder_id on cross-owner transfer and hides folder_id from non-owners", () => {
    const alice = createUser("alice", "password123");
    const bob = createUser("bob", "password123");
    const folder = createFolder(alice.id, "Private", null);
    const doc = createDocument(alice.id, emptyScene(), "Shared Doc", folder.id);

    // Same-owner transfer retains folder_id
    const sameOwner = transferOwnership(doc.id, alice.id, alice.id, "USER");
    expect(sameOwner.folder_id).toBe(folder.id);

    // Non-owner viewer meta hides folder_id
    const bobMeta = documentToMeta(sameOwner, bob.id, "USER", false);
    expect(bobMeta.folder_id).toBeNull();

    // Cross-owner transfer clears folder_id
    const transferred = transferOwnership(doc.id, bob.id, alice.id, "USER");
    expect(transferred.owner_id).toBe(bob.id);
    expect(transferred.folder_id).toBeNull();
  });

  it("runs idempotent migration on a legacy database without folders", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-folder-mig-"));
    const dbFile = path.join(tmpDir, "legacy.db");
    const legacyDb = new NodeDatabaseSync(dbFile);
    legacyDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'USER',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        scene TEXT NOT NULL DEFAULT '{}',
        thumbnail_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE decks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        active_recording_baseline_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb.exec(`
      INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
      VALUES ('u1', 'legacy_user', 'hash', 'USER', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO documents (id, title, owner_id, scene, thumbnail_path, created_at, updated_at, deleted_at)
      VALUES ('d1', 'Legacy Doc', 'u1', '{"elements":[]}', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO decks (id, title, owner_id, aspect_ratio, active_recording_baseline_id, created_at, updated_at)
      VALUES ('dk1', 'Legacy Deck', 'u1', '16:9', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    initializeSchema(legacyDb);
    initializeSchema(legacyDb); // repeatable

    const docCols = legacyDb.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    const deckCols = legacyDb.prepare("PRAGMA table_info(decks)").all() as { name: string }[];
    expect(docCols.some((c) => c.name === "folder_id")).toBe(true);
    expect(deckCols.some((c) => c.name === "folder_id")).toBe(true);
    const indexes = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(indexes.some((i) => i.name === "idx_documents_folder")).toBe(true);
    expect(indexes.some((i) => i.name === "idx_decks_folder")).toBe(true);

    const legacyDoc = legacyDb.prepare("SELECT owner_id, title, folder_id FROM documents WHERE id = 'd1'").get() as {
      owner_id: string;
      title: string;
      folder_id: string | null;
    };
    expect(legacyDoc).toEqual({ owner_id: "u1", title: "Legacy Doc", folder_id: null });
    const legacyDeck = legacyDb.prepare("SELECT owner_id, title, folder_id FROM decks WHERE id = 'dk1'").get() as {
      owner_id: string;
      title: string;
      folder_id: string | null;
    };
    expect(legacyDeck).toEqual({ owner_id: "u1", title: "Legacy Deck", folder_id: null });
    legacyDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enforces strict route validation, atomic folder PATCH, and fresh indexes", async () => {
    const owner = createUser("route_owner", "password123");
    const token = createSession(owner.id).token;
    const parent = createFolder(owner.id, "Parent", null);
    const child = createFolder(owner.id, "Child", parent.id);
    const doc = createDocument(owner.id, emptyScene(), "Route Doc", parent.id);
    const deck = createDeck(owner.id, "Route Deck", "16:9", parent.id);

    const docMove = await import("@/app/api/documents/[id]/move/route");
    const deckMove = await import("@/app/api/decks/[id]/move/route");
    const folderRoute = await import("@/app/api/folders/[id]/route");
    const docCreate = await import("@/app/api/documents/route");

    const req = (body: unknown) =>
      new Request("http://test.local/api", {
        method: "PATCH",
        headers: { cookie: `pew_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

    expect((await docMove.PATCH(req({}), ctx(doc.id))).status).toBe(400);
    expect(getDocumentRaw(doc.id)?.folder_id).toBe(parent.id);

    expect((await deckMove.PATCH(req({ folderId: 42 }), ctx(deck.id))).status).toBe(400);
    expect(getDeck(deck.id, owner.id, "USER").folderId).toBe(parent.id);

    // Explicit null moves to root
    expect((await docMove.PATCH(req({ folderId: null }), ctx(doc.id))).status).toBe(200);
    expect(getDocumentRaw(doc.id)?.folder_id).toBeNull();

    // Atomic folder PATCH: failed move rolls back rename
    expect((await folderRoute.PATCH(req({ name: "Bad Rename", parentId: child.id }), ctx(parent.id))).status).toBe(400);
    const parentRow = getDb().prepare("SELECT name FROM folders WHERE id = ?").get(parent.id) as { name: string };
    expect(parentRow.name).toBe("Parent");

    // Invalid destination on create rejects before creating document
    const beforeCount = (getDb().prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number }).c;
    expect((await docCreate.POST(req({ title: "Should Fail", folderId: "nonexistent" }))).status).toBe(404);
    const afterCount = (getDb().prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);

    // Fresh database has both folder indexes
    const indexes = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(indexes.some((i) => i.name === "idx_documents_folder")).toBe(true);
    expect(indexes.some((i) => i.name === "idx_decks_folder")).toBe(true);

    // Non-owner admin does not receive owner's private folderId on getDeck or Deck mutation routes
    const admin = createUser("deck_admin", "password123", "ADMIN");
    const adminToken = createSession(admin.id).token;
    const ownerDeck = getDeck(deck.id, owner.id, "USER");
    expect(ownerDeck.folderId).toBe(parent.id);
    const adminDeck = getDeck(deck.id, admin.id, "ADMIN");
    expect(adminDeck.folderId).toBeNull();

    const page2 = createBlankPage(deck.id, owner.id, "USER");
    const reorderRoute = await import("@/app/api/decks/[id]/pages/reorder/route");
    const pageDeleteRoute = await import("@/app/api/decks/[id]/pages/[pageId]/route");

    const reorderRes = await reorderRoute.POST(
      new Request("http://test.local/api", {
        method: "POST",
        headers: { cookie: `pew_session=${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ pageIds: [page2.id, ownerDeck.pages[0].id] }),
      }),
      { params: Promise.resolve({ id: deck.id }) },
    );
    expect(reorderRes.status).toBe(200);
    const reorderBody = (await reorderRes.json()) as { deck: { folderId: string | null } };
    expect(reorderBody.deck.folderId).toBeNull();

    const delRes = await pageDeleteRoute.DELETE(
      new Request("http://test.local/api", {
        method: "DELETE",
        headers: { cookie: `pew_session=${adminToken}` },
      }),
      { params: Promise.resolve({ id: deck.id, pageId: page2.id }) },
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deck: { folderId: string | null } };
    expect(delBody.deck.folderId).toBeNull();

    // Owner's folderId is preserved
    expect(getDeck(deck.id, owner.id, "USER").folderId).toBe(parent.id);
  });
});
