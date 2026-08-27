import { getDb } from "./db";
import { bootstrapAdmin, deleteExpiredSessions } from "./users";
import { compactSceneFiles } from "./attachments";
import { jsonToScene, sceneToJson } from "./types";

export interface MigrationResult {
  migratedDocs: number;
  migratedVersions: number;
  errors: string[];
}

/**
 * Idempotent startup migration: extracts legacy inline Base64 images from
 * existing documents and version snapshots into discrete /data/attachments
 * files and updates the database to use compact scenes.
 */
export function migrateLegacyScenes(): MigrationResult {
  const db = getDb();
  const errors: string[] = [];
  let migratedDocs = 0;
  let migratedVersions = 0;

  try {
    const docs = db
      .prepare("SELECT id, scene FROM documents WHERE scene LIKE '%data:image/%'")
      .all() as { id: string; scene: string }[];
    for (const d of docs) {
      try {
        const compact = compactSceneFiles(d.id, jsonToScene(d.scene), { allowInlineDataUrl: true });
        db.prepare("UPDATE documents SET scene = ? WHERE id = ?").run(sceneToJson(compact), d.id);
        migratedDocs++;
      } catch (err) {
        const msg = `Failed to migrate document scene for docId=${d.id}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        errors.push(msg);
      }
    }

    const versions = db
      .prepare("SELECT id, document_id, scene FROM document_versions WHERE scene LIKE '%data:image/%'")
      .all() as { id: string; document_id: string; scene: string }[];
    for (const v of versions) {
      try {
        const compact = compactSceneFiles(v.document_id, jsonToScene(v.scene), { allowInlineDataUrl: true });
        db.prepare("UPDATE document_versions SET scene = ? WHERE id = ?").run(sceneToJson(compact), v.id);
        migratedVersions++;
      } catch (err) {
        const msg = `Failed to migrate version scene for versionId=${v.id} (docId=${v.document_id}): ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        errors.push(msg);
      }
    }
  } catch (err) {
    const msg = `Database query error during legacy scene migration: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    errors.push(msg);
  }

  return { migratedDocs, migratedVersions, errors };
}

let initialized = false;

/**
 * Runs once at server startup: migrates the schema, bootstraps the initial
 * admin from env vars (only when no admin exists), prunes expired sessions,
 * and compacts any legacy scenes.
 */
export function initializeApp(): void {
  if (initialized) return;
  initialized = true;
  getDb(); // ensures schema + WAL setup
  bootstrapAdmin();
  deleteExpiredSessions();
  const res = migrateLegacyScenes();
  if (res.errors.length > 0) {
    console.warn(`[startup] Legacy scene migration finished with ${res.errors.length} error(s)`);
  }
}