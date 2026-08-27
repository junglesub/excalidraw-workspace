import path from "node:path";
import { rmSync } from "node:fs";
import { getDb, transaction } from "./db";
import { getDocumentRaw, requireRead } from "./documents";
import { forceDeleteAttachment } from "./attachments";
import { removeThumbnail } from "./thumbnails";
import { config } from "./config";
import { HttpError } from "./http";

/**
 * Permanently delete a document and all of its resources in a single atomic
 * transaction, then garbage-collect physical files no longer referenced
 * anywhere.
 *
 * Steps:
 *  1. remove version history rows
 *  2. remove membership rows
 *  3. remove share link
 *  4. remove attachment references
 *  5. delete the document record
 *  6. delete physical attachment files + thumbnail (GC)
 */
export function permanentDelete(
  docId: string,
  userId: string,
  role: "USER" | "ADMIN",
  adminMode = false,
): void {
  // Authorization: owner or admin (in admin mode) or admin trash.
  const doc = getDocumentRaw(docId);
  if (!doc) throw new HttpError(404, "Document not found");
  const allowed =
    role === "ADMIN" && adminMode
      ? true
      : role === "ADMIN" || doc.owner_id === userId
        ? true
        : false;
  if (!allowed) throw new HttpError(403, "Not allowed to permanently delete this document");
  void userId;

  const attachmentRows = getDb()
    .prepare("SELECT * FROM attachments WHERE document_id = ?")
    .all(docId) as { id: string; file_path: string }[];

  transaction(() => {
    getDb().prepare("DELETE FROM document_versions WHERE document_id = ?").run(docId);
    getDb().prepare("DELETE FROM document_members WHERE document_id = ?").run(docId);
    getDb().prepare("DELETE FROM share_links WHERE document_id = ?").run(docId);
    getDb().prepare("DELETE FROM attachments WHERE document_id = ?").run(docId);
    getDb().prepare("DELETE FROM documents WHERE id = ?").run(docId);
  });

  // GC physical files.
  const cfg = config();
  for (const a of attachmentRows) {
    const abs = path.join(cfg.dataDir, a.file_path);
    if (abs.startsWith(cfg.dataDir + path.sep)) {
      rmSync(abs, { force: true });
    }
  }
  removeThumbnail(doc.thumbnail_path);
  // Remove any leftover per-document attachment directory.
  const docDir = path.join(cfg.attachmentsDir, docId);
  if (docDir.startsWith(cfg.attachmentsDir)) {
    rmSync(docDir, { recursive: true, force: true });
  }
}

/** Convenience wrapper: verify read access first (owner/admin), then purge. */
export function requireOwnerAndPurge(
  docId: string,
  userId: string,
  role: "USER" | "ADMIN",
  adminMode = false,
): void {
  requireRead(docId, userId, role, adminMode);
  permanentDelete(docId, userId, role, adminMode);
}