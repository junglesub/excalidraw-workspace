import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser } from "@/lib/users";
import {
  createDocument,
  getDocumentRaw,
  renameDocument,
  updateScene,
  softDelete,
  restoreDocument,
  transferOwnership,
  resolvePermission,
  requireRead,
  requireWrite,
  listMyDocuments,
  listSharedDocuments,
  listTrashDocuments,
  addMember,
} from "@/lib/documents";
import { permanentDelete } from "@/lib/trash";
import { emptyScene } from "@/lib/types";

describe("Documents and Permissions", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should create document and list under owner", () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Project Plan");

    expect(doc.title).toBe("Project Plan");
    expect(doc.owner_id).toBe(owner.id);
    expect(doc.thumbnail_path).toBeDefined();

    const myDocs = listMyDocuments(owner.id);
    expect(myDocs).toHaveLength(1);
    expect(myDocs[0].id).toBe(doc.id);
    expect(myDocs[0].permission).toBe("OWNER");
  });

  it("should enforce permissions for OWNER, VIEWER, and non-members", () => {
    const owner = createUser("alice", "pass123", "USER");
    const viewer = createUser("bob", "pass123", "USER");
    const stranger = createUser("charlie", "pass123", "USER");

    const doc = createDocument(owner.id, emptyScene(), "Architecture");
    addMember(doc.id, viewer.id, "VIEWER");

    // Owner has full read and write
    expect(resolvePermission(doc.id, owner.id, "USER")).toBe("OWNER");
    expect(() => requireRead(doc.id, owner.id, "USER")).not.toThrow();
    expect(() => requireWrite(doc.id, owner.id, "USER")).not.toThrow();

    // Viewer has read permission but cannot write
    expect(resolvePermission(doc.id, viewer.id, "USER")).toBe("VIEWER");
    expect(() => requireRead(doc.id, viewer.id, "USER")).not.toThrow();
    expect(() => requireWrite(doc.id, viewer.id, "USER")).toThrowError(/Read-only/);

    // Stranger has no permission
    expect(resolvePermission(doc.id, stranger.id, "USER")).toBeUndefined();
    expect(() => requireRead(doc.id, stranger.id, "USER")).toThrowError(/Access denied/);
    expect(() => requireWrite(doc.id, stranger.id, "USER")).toThrowError(/Access denied/);

    // Viewer sees document in shared list
    const sharedDocs = listSharedDocuments(viewer.id);
    expect(sharedDocs).toHaveLength(1);
    expect(sharedDocs[0].id).toBe(doc.id);
  });

  it("should allow admin mode to access any document", () => {
    const owner = createUser("alice", "pass123", "USER");
    const admin = createUser("superadmin", "pass123", "ADMIN");
    const doc = createDocument(owner.id, emptyScene(), "Confidential");

    // Admin in adminMode = true has admin permission
    expect(resolvePermission(doc.id, admin.id, "ADMIN", true)).toBe("admin");
    expect(() => requireWrite(doc.id, admin.id, "ADMIN", true)).not.toThrow();
  });

  it("should handle rename and scene updates", () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Draft 1");

    const renamed = renameDocument(doc.id, "Draft 2", owner.id, "USER", false);
    expect(renamed.title).toBe("Draft 2");

    const newScene = {
      ...emptyScene(),
      elements: [{ id: "elem-1", type: "rectangle", x: 10, y: 20, width: 100, height: 100 }],
    };
    const updated = updateScene(doc.id, newScene, owner.id, "USER", false);
    expect(updated.scene).toContain("elem-1");
  });

  it("should support soft delete to trash, restore, and permanent purge", () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Temporary Doc");

    // Soft delete
    softDelete(doc.id, owner.id, "USER");
    expect(listMyDocuments(owner.id)).toHaveLength(0);
    const trash = listTrashDocuments(owner.id, false);
    expect(trash).toHaveLength(1);
    expect(trash[0].id).toBe(doc.id);

    // Restore
    restoreDocument(doc.id, owner.id, "USER");
    expect(listMyDocuments(owner.id)).toHaveLength(1);
    expect(listTrashDocuments(owner.id, false)).toHaveLength(0);

    // Permanent delete
    softDelete(doc.id, owner.id, "USER");
    permanentDelete(doc.id, owner.id, "USER");
    expect(getDocumentRaw(doc.id)).toBeUndefined();
    expect(listTrashDocuments(owner.id, false)).toHaveLength(0);
  });

  it("should transfer document ownership atomically", () => {
    const ownerA = createUser("alice", "pass123", "USER");
    const userB = createUser("bob", "pass123", "USER");
    const doc = createDocument(ownerA.id, emptyScene(), "Team Roadmap");

    transferOwnership(doc.id, userB.id, ownerA.id, "USER");

    const updatedDoc = getDocumentRaw(doc.id)!;
    expect(updatedDoc.owner_id).toBe(userB.id);

    // Former owner becomes EDITOR
    expect(resolvePermission(doc.id, ownerA.id, "USER")).toBe("EDITOR");
    expect(resolvePermission(doc.id, userB.id, "USER")).toBe("OWNER");
  });
});
