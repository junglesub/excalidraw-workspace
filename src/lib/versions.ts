import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { getDb, transaction } from "./db";
import { getDocumentRaw, MAX_VERSIONS, AUTO_SNAPSHOT_INTERVAL_MS, requireWrite } from "./documents";
import { saveThumbnail, saveThumbnailFromBuffer, removeThumbnail } from "./thumbnails";
import { compactSceneFiles, gcUnreferencedAttachments } from "./attachments";
import type { DocumentVersionRow, ExcalidrawScene, VersionOrigin } from "./types";
import { emptyScene, jsonToScene, sceneToJson } from "./types";
import { HttpError } from "./http";
import { serializeForComparison } from "./scene_normalize";

export type { VersionOrigin };

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
  options?: { allowInlineDataUrl?: boolean; origin?: VersionOrigin | null },
): DocumentVersionRow {
  const db = getDb();
  const maxRow = db
    .prepare("SELECT MAX(version_number) AS m FROM document_versions WHERE document_id = ?")
    .get(docId) as { m: number | null };
  const versionNumber = (maxRow?.m ?? 0) + 1;
  const id = crypto.randomUUID();
  const created = nowIso();
  const compactScene = compactSceneFiles(docId, scene, { allowInlineDataUrl: options?.allowInlineDataUrl ?? false });
  const origin = options?.origin ?? null;

  let thumbnailPath: string | null = null;
  if (makeThumbnail) {
    if (thumbnailBuffer) {
      const versionThumb = saveThumbnailFromBuffer(`${docId}-v${versionNumber}`, thumbnailBuffer);
      thumbnailPath = versionThumb.relativePath;
      try {
        const docThumb = saveThumbnailFromBuffer(docId, thumbnailBuffer);
        db.prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?").run(docThumb.relativePath, docId);
      } catch {
        // ignore
      }
    } else {
      const versionThumb = saveThumbnail(`${docId}-v${versionNumber}`, scene);
      thumbnailPath = versionThumb.relativePath;
      try {
        const doc = getDocumentRaw(docId);
        const cfg = config();
        const docThumbPath = `thumbnails/${docId}.png`;
        const docThumbAbs = path.resolve(cfg.dataDir, docThumbPath);
        if (!doc?.thumbnail_path && existsSync(docThumbAbs)) {
          db.prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?").run(docThumbPath, docId);
        }
      } catch {
        // ignore
      }
    }
  }

  db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, scene, thumbnail_path, created_by, created_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, docId, versionNumber, sceneToJson(compactScene), thumbnailPath, createdBy, created, origin);

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
    if (t.thumbnail_path && t.thumbnail_path !== `thumbnails/${docId}.png` && t.thumbnail_path !== `thumbnails\\${docId}.png`) {
      removeThumbnail(t.thumbnail_path);
    }
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
  options?: { allowInlineDataUrl?: boolean; origin?: VersionOrigin | null },
): DocumentVersionRow {
  const doc = getDocumentRaw(docId);
  if (!doc) throw new HttpError(404, "Document not found");
  return insertSnapshot(docId, jsonToScene(doc.scene), createdBy, makeThumbnail, thumbnailBuffer, options);
}

export function createSnapshotFromScene(
  docId: string,
  scene: ExcalidrawScene,
  createdBy: string,
  makeThumbnail = true,
  thumbnailBuffer?: Buffer | null,
  options?: { allowInlineDataUrl?: boolean; origin?: VersionOrigin | null },
): DocumentVersionRow {
  return insertSnapshot(docId, scene, createdBy, makeThumbnail, thumbnailBuffer, options);
}

export function getVersion(id: string): DocumentVersionRow | undefined {
  return getDb().prepare("SELECT * FROM document_versions WHERE id = ?").get(id) as
    | DocumentVersionRow
    | undefined;
}

export function listVersions(docId: string): Omit<DocumentVersionRow, "scene">[] {
  const rows = getDb()
    .prepare(
      `SELECT v.id, v.document_id, v.version_number, v.thumbnail_path, v.created_by, v.created_at, v.origin,
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

export { serializeForComparison };

export function handleManualSave(
  docId: string,
  actorId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
  scene: ExcalidrawScene,
  thumbnailBuffer: Buffer | null,
): { alreadySaved: boolean; snapshotCreated: boolean; snapshot?: DocumentVersionRow; versions: Omit<DocumentVersionRow, "scene">[] } {
  requireWrite(docId, actorId, role, adminMode);
  return transaction(() => {
    const current = getDocumentRaw(docId);
    if (!current) throw new HttpError(404, "Document not found");

    // Validate incoming scene's attachments (throws 400 if missing)
    const compactIncoming = compactSceneFiles(docId, scene, { allowInlineDataUrl: false });

    const currentScene = jsonToScene(current.scene);
    const latestRow = getDb()
      .prepare("SELECT scene FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1")
      .get(docId) as { scene: string } | undefined;
    const latestScene = latestRow ? jsonToScene(latestRow.scene) : null;

    const incomingSerialized = serializeForComparison(compactIncoming);
    const latestSerialized = latestScene ? serializeForComparison(latestScene) : null;
    const currentSerialized = serializeForComparison(currentScene);

    if (
      latestSerialized !== null &&
      incomingSerialized === latestSerialized &&
      incomingSerialized === currentSerialized
    ) {
      return { alreadySaved: true, snapshotCreated: false, versions: listVersions(docId) };
    }

    // Need to create snapshot. Update document only if incoming differs from current.
    let snapshot: DocumentVersionRow | undefined;
    if (incomingSerialized !== currentSerialized) {
      const thumbPath = thumbnailBuffer ? saveThumbnailFromBuffer(docId, thumbnailBuffer).relativePath : null;
      // If no thumbnail buffer, try to generate placeholder if needed (mirrors updateScene logic)
      let finalThumbPath: string | null = thumbPath;
      if (!finalThumbPath && !current.thumbnail_path) {
        try {
          finalThumbPath = saveThumbnail(docId, compactIncoming).relativePath;
        } catch {
          // ignore
        }
      }
      getDb()
        .prepare("UPDATE documents SET scene = ?, thumbnail_path = COALESCE(?, thumbnail_path), updated_at = ? WHERE id = ?")
        .run(sceneToJson(compactIncoming), finalThumbPath, nowIso(), docId);
      gcUnreferencedAttachments(docId);
    }

    // Create exactly one manual_save snapshot (even if document was already saved)
    snapshot = insertSnapshot(docId, compactIncoming, actorId, true, thumbnailBuffer, { origin: "manual_save" });

    return { alreadySaved: false, snapshotCreated: true, snapshot, versions: listVersions(docId) };
  });
}

export interface ResolveRecoveryConflictInput {
  choice: "client" | "server";
  preserveDiscarded: boolean;
  expectedServerUpdatedAt: string;
  clientScene: ExcalidrawScene;
  thumbnailBuffer?: Buffer | null;
}

export type ResolveRecoveryConflictResult =
  | {
      ok: true;
      choice: "client" | "server";
      snapshotCreated: boolean;
      updatedAt: string;
    }
  | {
      ok: false;
      code: "SERVER_VERSION_CHANGED";
      serverScene: ExcalidrawScene;
      serverUpdatedAt: string;
    };

export function resolveRecoveryConflict(
  docId: string,
  actorId: string,
  role: "USER" | "ADMIN",
  adminMode: boolean,
  input: ResolveRecoveryConflictInput,
): ResolveRecoveryConflictResult {
  requireWrite(docId, actorId, role, adminMode);
  return transaction(() => {
    const current = getDocumentRaw(docId);
    if (!current) throw new HttpError(404, "Document not found");
    const serverScene = jsonToScene(current.scene);
    if (current.updated_at !== input.expectedServerUpdatedAt) {
      return {
        ok: false,
        code: "SERVER_VERSION_CHANGED",
        serverScene,
        serverUpdatedAt: current.updated_at,
      };
    }

    const mustKeepClient = input.choice === "client" || input.preserveDiscarded;
    const compactClient = mustKeepClient ? compactSceneFiles(docId, input.clientScene) : null;
    let snapshotCreated = false;
    let updatedAt = current.updated_at;

    if (input.choice === "client") {
      updatedAt = new Date(
        Math.max(Date.now(), new Date(current.updated_at).getTime() + 1),
      ).toISOString();
      getDb()
        .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
        .run(sceneToJson(compactClient!), updatedAt, docId);
      if (input.preserveDiscarded) {
        insertSnapshot(docId, serverScene, actorId, true, null, { origin: "recovery_server_version" });
        snapshotCreated = true;
      }
    } else if (input.preserveDiscarded) {
      insertSnapshot(docId, compactClient!, actorId, true, input.thumbnailBuffer, {
        origin: "recovery_client_draft",
      });
      snapshotCreated = true;
    }

    gcUnreferencedAttachments(docId);
    return { ok: true, choice: input.choice, snapshotCreated, updatedAt };
  });
}

/**
 * Restore a document to a past version. Snapshots the pre-restore current
 * state with origin "restore", then applies the selected history version
 * as the document current scene.
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
    const preDoc = getDocumentRaw(docId);
    if (!preDoc) throw new HttpError(404, "Document not found");
    const preScene = jsonToScene(preDoc.scene);
    const cfg = config();
    let preThumbBuf: Buffer | null = null;
    if (preDoc.thumbnail_path) {
      const preThumbAbs = path.resolve(cfg.dataDir, preDoc.thumbnail_path);
      if (existsSync(preThumbAbs)) {
        try {
          preThumbBuf = readFileSync(preThumbAbs);
        } catch {
          // ignore
        }
      }
    } else {
      const fallbackAbs = path.resolve(cfg.dataDir, `thumbnails/${docId}.png`);
      if (existsSync(fallbackAbs)) {
        try {
          preThumbBuf = readFileSync(fallbackAbs);
        } catch {
          // ignore
        }
      }
    }

    const newSnapshot = insertSnapshot(docId, preScene, actorId, true, preThumbBuf, { origin: "restore" });

    const scene = jsonToScene(version.scene);
    const compact = compactSceneFiles(docId, scene);
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(compact), nowIso(), docId);

    let versionThumbBuf: Buffer | null = null;
    if (version.thumbnail_path) {
      const versionThumbAbs = path.resolve(cfg.dataDir, version.thumbnail_path);
      if (existsSync(versionThumbAbs)) {
        try {
          versionThumbBuf = readFileSync(versionThumbAbs);
        } catch {
          // ignore
        }
      }
    }

    if (versionThumbBuf) {
      const docThumb = saveThumbnailFromBuffer(docId, versionThumbBuf);
      getDb()
        .prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?")
        .run(docThumb.relativePath, docId);
    } else {
      const doc = getDocumentRaw(docId);
      const docThumbPath = `thumbnails/${docId}.png`;
      const docThumbAbs = path.resolve(cfg.dataDir, docThumbPath);
      if (!doc?.thumbnail_path || (!existsSync(path.resolve(cfg.dataDir, doc.thumbnail_path)) && existsSync(docThumbAbs))) {
        getDb()
          .prepare("UPDATE documents SET thumbnail_path = ? WHERE id = ?")
          .run(docThumbPath, docId);
      }
    }

    gcUnreferencedAttachments(docId);
    return newSnapshot;
  });
}

export { emptyScene };
export const AUTO_INTERVAL = AUTO_SNAPSHOT_INTERVAL_MS;