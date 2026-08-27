import { getDb, transaction } from "./db";
import { getDocumentRaw, MAX_VERSIONS, AUTO_SNAPSHOT_INTERVAL_MS, requireWrite } from "./documents";
import { saveThumbnail, saveThumbnailFromBuffer, removeThumbnail } from "./thumbnails";
import { compactSceneFiles, gcUnreferencedAttachments } from "./attachments";
import type { DocumentVersionRow, ExcalidrawScene } from "./types";
import { emptyScene, jsonToScene, sceneToJson } from "./types";
import { HttpError } from "./http";

function nowIso(): string {
  return new Date().toISOString();
}

export interface CreateSnapshotOptions {
  thumbnail?: boolean;
}

/** Insert a recovery snapshot, trimming history to the newest MAX_VERSIONS. */
function insertSnapshot(
  docId: string,
  scene: ExcalidrawScene,
  createdBy: string,
  makeThumbnail: boolean,
  thumbnailBuffer?: Buffer | null,
): DocumentVersionRow {
  const db = getDb();
  const maxRow = db
    .prepare("SELECT MAX(version_number) AS m FROM document_versions WHERE document_id = ?")
    .get(docId) as { m: number | null };
  const versionNumber = (maxRow?.m ?? 0) + 1;
  const id = crypto.randomUUID();
  const created = nowIso();
  const compactScene = compactSceneFiles(docId, scene);

  let thumbnailPath: string | null = null;
  if (makeThumbnail) {
    if (thumbnailBuffer) {
      const thumb = saveThumbnailFromBuffer(`${docId}-v${versionNumber}`, thumbnailBuffer);
      thumbnailPath = thumb.relativePath;
      try {
        saveThumbnailFromBuffer(docId, thumbnailBuffer);
        db.prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?").run(thumbnailPath, docId);
      } catch {
        // ignore
      }
    } else {
      const thumb = saveThumbnail(`${docId}-v${versionNumber}`, scene);
      thumbnailPath = thumb.relativePath;
      try {
        const docThumb = saveThumbnail(docId, scene);
        db.prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?").run(docThumb.relativePath, docId);
      } catch {
        // ignore
      }
    }
  }

  db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, scene, thumbnail_path, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, docId, versionNumber, sceneToJson(compactScene), thumbnailPath, createdBy, created);

  // Trim to the newest MAX_VERSIONS and GC physical thumbnail files.
  const trimmed = db
    .prepare(
      `SELECT thumbnail_path FROM document_versions
       WHERE document_id = ? AND id NOT IN (
          SELECT id FROM document_versions WHERE document_id = ?
          ORDER BY created_at DESC, version_number DESC LIMIT ?
       )`,
    )
    .all(docId, docId, MAX_VERSIONS) as { thumbnail_path: string | null }[];

  for (const t of trimmed) {
    removeThumbnail(t.thumbnail_path);
  }

  db.prepare(
    `DELETE FROM document_versions
     WHERE document_id = ? AND id NOT IN (
        SELECT id FROM document_versions WHERE document_id = ?
        ORDER BY created_at DESC, version_number DESC LIMIT ?
     )`,
  ).run(docId, docId, MAX_VERSIONS);

  gcUnreferencedAttachments(docId);

  return getVersion(id)!;
}

/**
 * Create a snapshot from the current scene. Used both by manual Save (always)
 * and by auto-save when throttled (>=5 min since last snapshot).
 */
export function createSnapshotFromDoc(
  docId: string,
  createdBy: string,
  makeThumbnail = true,
  thumbnailBuffer?: Buffer | null,
): DocumentVersionRow {
  const doc = getDocumentRaw(docId);
  if (!doc) throw new HttpError(404, "Document not found");
  return insertSnapshot(docId, jsonToScene(doc.scene), createdBy, makeThumbnail, thumbnailBuffer);
}

export function createSnapshotFromScene(
  docId: string,
  scene: ExcalidrawScene,
  createdBy: string,
  makeThumbnail = true,
  thumbnailBuffer?: Buffer | null,
): DocumentVersionRow {
  return insertSnapshot(docId, scene, createdBy, makeThumbnail, thumbnailBuffer);
}

export function getVersion(id: string): DocumentVersionRow | undefined {
  return getDb().prepare("SELECT * FROM document_versions WHERE id = ?").get(id) as
    | DocumentVersionRow
    | undefined;
}

export function listVersions(docId: string): Omit<DocumentVersionRow, "scene">[] {
  const rows = getDb()
    .prepare(
      `SELECT v.id, v.document_id, v.version_number, v.thumbnail_path, v.created_by, v.created_at,
              u.username AS created_by_username
       FROM document_versions v JOIN users u ON u.id = v.created_by
       WHERE v.document_id = ? ORDER BY v.version_number DESC`,
    )
    .all(docId) as (Omit<DocumentVersionRow, "scene"> & { created_by_username: string })[];
  return rows as unknown as Omit<DocumentVersionRow, "scene">[];
}

/** Time since the most recent snapshot, in ms. */
export function msSinceLastSnapshot(docId: string): number {
  const row = getDb()
    .prepare("SELECT created_at FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1")
    .get(docId) as { created_at: string } | undefined;
  if (!row) return Number.POSITIVE_INFINITY;
  return Date.now() - new Date(row.created_at).getTime();
}

/** Returns true when an auto-save snapshot is due (>= 5 minutes since last). */
export function snapshotDueForAutoSave(docId: string, intervalMs: number): boolean {
  return msSinceLastSnapshot(docId) >= intervalMs;
}

/**
 * Restore a document to a past version. The restore is committed as a new
 * current state (a fresh snapshot of the restored scene is recorded).
 */
export function restoreVersion(
  docId: string,
  versionId: string,
  actorId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
): DocumentVersionRow {
  requireWrite(docId, actorId, role, adminMode);
  return transaction(() => {
    const version = getVersion(versionId);
    if (!version || version.document_id !== docId) {
      throw new HttpError(404, "Version not found");
    }
    const scene = jsonToScene(version.scene);
    const compact = compactSceneFiles(docId, scene);
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(compact), nowIso(), docId);
    // Commit the restore as a new current state snapshot.
    const newSnapshot = insertSnapshot(docId, scene, actorId, true);
    // Refresh the document-level thumbnail too.
    const thumb = saveThumbnail(docId, scene);
    getDb()
      .prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?")
      .run(thumb.relativePath, docId);
    gcUnreferencedAttachments(docId);
    return newSnapshot;
  });
}

export { emptyScene };
export const AUTO_INTERVAL = AUTO_SNAPSHOT_INTERVAL_MS;