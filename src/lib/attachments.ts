import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getDb } from "./db";
import { config } from "./config";
import type { AttachmentRow } from "./types";
import {
  getDocumentRaw,
  isAnySnapshotReferencingAttachment,
  isSceneReferencingAttachment,
} from "./documents";

/** Public URL token embedded in scenes to reference an attachment. */
export function attachUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}`;
}

export function safeFileName(fileName: string): string {
  return path.basename(fileName || "file").replace(/[^\w.\- ]+/g, "_") || "file";
}

/**
 * Persist an uploaded file under /data/attachments/<docId>/<fileId> and record
 * its metadata. Returns the attachment row.
 */
export function storeAttachment(
  docId: string,
  fileName: string,
  mimeType: string,
  data: Buffer,
): AttachmentRow {
  const db = getDb();
  const id = randomUUID();
  const cfg = config();
  const dir = path.join(cfg.attachmentsDir, docId);
  mkdirSync(dir, { recursive: true });
  const relativePath = path.posix
    .join("attachments", docId, id)
    .replace(/\//g, path.sep);
  const abs = path.join(cfg.dataDir, relativePath);
  writeFileSync(abs, data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    docId,
    safeFileName(fileName),
    data.length,
    mimeType,
    relativePath,
    sha256,
    createdAt,
  );
  return getAttachmentById(id)!;
}

export function getAttachmentById(id: string): AttachmentRow | undefined {
  return getDb().prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
    | AttachmentRow
    | undefined;
}

export function listAttachments(docId: string): AttachmentRow[] {
  return getDb()
    .prepare("SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at ASC")
    .all(docId) as AttachmentRow[];
}

export function resolveAttachmentFilesystem(row: AttachmentRow): string {
  return path.join(config().dataDir, row.file_path);
}

export function readAttachmentBytes(row: AttachmentRow): Buffer {
  return readFileSync(resolveAttachmentFilesystem(row));
}

/**
 * Delete an attachment's physical file only when no longer referenced by the
 * current scene or any preserved snapshot (version-safe retention).
 */
export function deleteAttachmentIfUnreferenced(docId: string, attachmentId: string): boolean {
  const row = getAttachmentById(attachmentId);
  if (!row) return false;
  const token = attachUrl(attachmentId);
  const doc = getDocumentRaw(docId);
  if (!doc) return false;
  const referencedByCurrent = isSceneReferencingAttachment(doc, token);
  const referencedBySnapshot = isAnySnapshotReferencingAttachment(docId, token);
  if (referencedByCurrent || referencedBySnapshot) {
    return false; // still referenced, retain the file
  }
  getDb().prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
  rmSync(resolveAttachmentFilesystem(row), { force: true });
  return true;
}

/** Force-remove an attachment regardless of references (used on permanent delete). */
export function forceDeleteAttachment(attachmentId: string): void {
  const row = getAttachmentById(attachmentId);
  if (!row) return;
  getDb().prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
  rmSync(resolveAttachmentFilesystem(row), { force: true });
}