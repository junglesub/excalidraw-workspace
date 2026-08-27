import { getDb, transaction } from "./db";
import { getById as getUserId } from "./users";
import { saveThumbnail } from "./thumbnails";
import type {
  DocumentMeta,
  DocumentRow,
  ExcalidrawScene,
  Permission,
} from "./types";
import { jsonToScene, sceneToJson } from "./types";
import { HttpError } from "./http";

export const MAX_VERSIONS = 20;
export const AUTO_SAVE_DEBOUNCE_MS = 3000; // ~3s debounce
export const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Effective permission an authenticated user holds over a document. */
export type EffectivePermission = Permission | "admin";

/**
 * Resolve the permission a user has for a document. `adminMode` grants
 * system-wide access to admins regardless of ownership (Admin Mode).
 */
export function resolvePermission(
  docId: string,
  userId: string,
  userRole: "USER" | "ADMIN",
  adminMode = false,
): EffectivePermission | undefined {
  const db = getDb();
  const doc = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(docId) as DocumentRow | undefined;
  if (!doc) return undefined;

  if (adminMode && userRole === "ADMIN") {
    return "admin";
  }
  if (doc.owner_id === userId) {
    return "OWNER";
  }
  const member = db
    .prepare("SELECT permission FROM document_members WHERE document_id = ? AND user_id = ?")
    .get(docId, userId) as { permission: Permission } | undefined;
  if (member) {
    return member.permission;
  }
  return undefined;
}

export function requireRead(
  docId: string,
  userId: string,
  userRole: "USER" | "ADMIN",
  adminMode = false,
): { doc: DocumentRow; permission: EffectivePermission } {
  const doc = getDocumentRaw(docId);
  if (!doc) throw new HttpError(404, "Document not found");
  const permission = resolvePermission(docId, userId, userRole, adminMode);
  if (!permission) throw new HttpError(403, "Access denied");
  return { doc, permission };
}

export function requireWrite(
  docId: string,
  userId: string,
  userRole: "USER" | "ADMIN",
  adminMode = false,
): { doc: DocumentRow; permission: EffectivePermission } {
  const { doc, permission } = requireRead(docId, userId, userRole, adminMode);
  if (permission === "VIEWER") {
    throw new HttpError(403, "Read-only access");
  }
  return { doc, permission };
}

export function getDocumentRaw(id: string): DocumentRow | undefined {
  return getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as
    | DocumentRow
    | undefined;
}

export function createDocument(userId: string, scene: ExcalidrawScene, title = "Untitled"): DocumentRow {
  return transaction(() => {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let thumbPath: string | null = null;
    try {
      thumbPath = saveThumbnail(id, scene).relativePath;
    } catch {
      // ignore
    }
    db.prepare(
      `INSERT INTO documents (id, title, owner_id, scene, thumbnail_path, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, title, userId, sceneToJson(scene), thumbPath, now, now);
    return getDocumentRaw(id)!;
  });
}

function toMeta(
  doc: DocumentRow,
  viewerId: string,
  viewerRole: "USER" | "ADMIN",
  adminMode: boolean,
): DocumentMeta {
  const owner = getUserId(doc.owner_id);
  const perm = resolvePermission(doc.id, viewerId, viewerRole, adminMode);
  let thumbPath = doc.thumbnail_path;
  if (!thumbPath) {
    try {
      const scene = jsonToScene(doc.scene);
      thumbPath = saveThumbnail(doc.id, scene).relativePath;
      getDb().prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?").run(thumbPath, doc.id);
    } catch {
      // ignore
    }
  }
  return {
    id: doc.id,
    title: doc.title,
    owner_id: doc.owner_id,
    owner_username: owner?.username || "deleted",
    permission: perm && perm !== "admin" ? perm : "VIEWER",
    thumbnail_path: thumbPath,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    deleted_at: doc.deleted_at,
  };
}

export function listMyDocuments(userId: string): DocumentMeta[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM documents WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
    )
    .all(userId) as DocumentRow[];
  return rows.map((d) => toMeta(d, userId, "USER", false));
}

export function listSharedDocuments(userId: string): DocumentMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT d.* FROM documents d
       JOIN document_members m ON m.document_id = d.id
       WHERE m.user_id = ? AND d.owner_id <> ? AND d.deleted_at IS NULL
       ORDER BY d.updated_at DESC`,
    )
    .all(userId, userId) as DocumentRow[];
  return rows.map((d) => toMeta(d, userId, "USER", false));
}

export function listTrashDocuments(userId: string, isAdmin: boolean): DocumentMeta[] {
  let rows: DocumentRow[];
  if (isAdmin) {
    rows = getDb()
      .prepare("SELECT * FROM documents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all() as DocumentRow[];
  } else {
    rows = getDb()
      .prepare(
        "SELECT * FROM documents WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
      )
      .all(userId) as DocumentRow[];
  }
  return rows.map((d) => toMeta(d, userId, isAdmin ? "ADMIN" : "USER", isAdmin));
}

/** Admin-mode listing of every document (including deleted). */
export function listAllDocuments(adminId: string): DocumentMeta[] {
  const rows = getDb()
    .prepare("SELECT * FROM documents ORDER BY updated_at DESC")
    .all() as DocumentRow[];
  return rows.map((d) => toMeta(d, adminId, "ADMIN", true));
}
export function renameDocument(
  docId: string,
  title: string,
  userId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
): DocumentRow {
  const { permission } = requireWrite(docId, userId, role, adminMode);
  if (permission !== "admin" && permission !== "OWNER" && permission !== "EDITOR") {
    throw new HttpError(403, "Only editors/owners may rename");
  }
  getDb()
    .prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, new Date().toISOString(), docId);
  return getDocumentRaw(docId)!;
}

/** Auto-save: writes the scene without creating a new recovery snapshot. */
export function updateScene(
  docId: string,
  scene: ExcalidrawScene,
  userId: string,
  role: "USER" | "ADMIN",
  adminMode = false,
): DocumentRow {
  requireWrite(docId, userId, role, adminMode);
  let thumbPath: string | null = null;
  try {
    thumbPath = saveThumbnail(docId, scene).relativePath;
  } catch {
    // ignore
  }
  getDb()
    .prepare("UPDATE documents SET scene = ?, thumbnail_path = COALESCE(?, thumbnail_path), updated_at = ? WHERE id = ?")
    .run(sceneToJson(scene), thumbPath, new Date().toISOString(), docId);
  return getDocumentRaw(docId)!;
}

export function getDocumentWithScene(
  docId: string,
  userId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
) {
  const { doc, permission } = requireRead(docId, userId, role, adminMode);
  return { doc, scene: jsonToScene(doc.scene), permission };
}

export function softDelete(docId: string, userId: string, role: "USER" | "ADMIN"): void {
  requireWrite(docId, userId, role, false);
  getDb()
    .prepare("UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), docId);
}

export function restoreDocument(docId: string, userId: string, role: "USER" | "ADMIN"): void {
  const doc = getDocumentRaw(docId);
  if (!doc) throw new HttpError(404, "Document not found");
  const canRestore = role === "ADMIN" || doc.owner_id === userId;
  if (!canRestore) throw new HttpError(403, "Cannot restore this document");
  getDb()
    .prepare("UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), docId);
}

/** Whether the current document scene references a file token (URL/ref). */
export function isSceneReferencingAttachment(doc: DocumentRow, token: string): boolean {
  return doc.scene.includes(token);
}

/** Whether any preserved snapshot references the token. */
export function isAnySnapshotReferencingAttachment(docId: string, token: string): boolean {
  const rows = getDb()
    .prepare("SELECT scene FROM document_versions WHERE document_id = ?")
    .all(docId) as { scene: string }[];
  return rows.some((r) => r.scene.includes(token));
}

function upsertMember(docId: string, userId: string, permission: Permission, now: string) {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM document_members WHERE document_id = ? AND user_id = ?")
    .get(docId, userId) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE document_members SET permission = ?, updated_at = ? WHERE id = ?").run(
      permission,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      "INSERT INTO document_members (id, document_id, user_id, permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), docId, userId, permission, now, now);
  }
}

function removeMemberRow(docId: string, userId: string) {
  getDb().prepare("DELETE FROM document_members WHERE document_id = ? AND user_id = ?").run(docId, userId);
}

function setDocOwner(docId: string, ownerId: string, now: string) {
  getDb().prepare("UPDATE documents SET owner_id = ?, updated_at = ? WHERE id = ?").run(ownerId, now, docId);
  removeMemberRow(docId, ownerId);
}

/**
 * Ownership transfer executed atomically. After transfer the new user owns the
 * document and the previous owner keeps EDITOR access.
 */
export function transferOwnership(
  docId: string,
  newOwnerId: string,
  currentUserId: string,
  role: "USER" | "ADMIN",
): DocumentRow {
  return transaction(() => {
    const doc = getDocumentRaw(docId);
    if (!doc) throw new HttpError(404, "Document not found");
    if (role !== "ADMIN" && doc.owner_id !== currentUserId) {
      throw new HttpError(403, "Only the owner may transfer ownership");
    }
    const newOwner = getUserId(newOwnerId);
    if (!newOwner) throw new HttpError(404, "Target user not found");
    const now = new Date().toISOString();

    const oldOwnerId = doc.owner_id;
    if (oldOwnerId !== newOwnerId) {
      upsertMember(docId, oldOwnerId, "EDITOR", now);
    }
    setDocOwner(docId, newOwnerId, now);
    return getDocumentRaw(docId)!;
  });
}

export function listMembers(
  docId: string,
): { user_id: string; username: string; permission: Permission }[] {
  return getDb()
    .prepare(
      `SELECT m.user_id, u.username, m.permission FROM document_members m
       JOIN users u ON u.id = m.user_id WHERE m.document_id = ?`,
    )
    .all(docId) as unknown as { user_id: string; username: string; permission: Permission }[];
}

export function addMember(docId: string, userId: string, permission: Permission) {
  const now = new Date().toISOString();
  upsertMember(docId, userId, permission, now);
}

export function removeMember(docId: string, userId: string) {
  removeMemberRow(docId, userId);
}

export function documentToMeta(
  doc: DocumentRow,
  viewerId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
): DocumentMeta {
  return toMeta(doc, viewerId, role, adminMode);
}
