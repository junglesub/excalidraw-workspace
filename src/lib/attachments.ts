import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { getDb } from "./db";
import { config } from "./config";
import type { AttachmentRow, ExcalidrawScene } from "./types";
import { getDocumentRaw } from "./documents";
import { HttpError } from "./http";

export const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/jfif",
  "image/pjpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const BASE64_SYNTAX_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isValidBase64String(str: string): boolean {
  const cleaned = str.replace(/[\r\n\s]+/g, "");
  if (cleaned.length === 0 || cleaned.length % 4 !== 0) {
    return false;
  }
  return BASE64_SYNTAX_REGEX.test(cleaned);
}

/** Public URL token embedded in scenes to reference an attachment. */
export function attachUrl(attachmentId: string, docId?: string): string {
  if (docId) {
    return `/api/attachments/${attachmentId}?docId=${encodeURIComponent(docId)}`;
  }
  return `/api/attachments/${attachmentId}`;
}

export function safeFileName(fileName: string): string {
  return path.basename(fileName || "file").replace(/[^\w.\- ]+/g, "_") || "file";
}

/** Document-scoped lookup for an attachment row. */
export function getAttachment(docId: string, id: string): AttachmentRow | undefined {
  return getDb()
    .prepare("SELECT * FROM attachments WHERE document_id = ? AND id = ?")
    .get(docId, id) as AttachmentRow | undefined;
}

/** Global or document-scoped lookup for an attachment row. */
export function getAttachmentById(id: string, docId?: string): AttachmentRow | undefined {
  if (docId) {
    return getAttachment(docId, id);
  }
  return getDb()
    .prepare("SELECT * FROM attachments WHERE id = ? LIMIT 1")
    .get(id) as AttachmentRow | undefined;
}

export function listAttachments(docId: string): AttachmentRow[] {
  return getDb()
    .prepare("SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at ASC")
    .all(docId) as AttachmentRow[];
}

export function resolveAttachmentFilesystem(row: AttachmentRow): string {
  const dataDir = path.resolve(config().dataDir);
  const docAttachmentsDir = path.resolve(config().attachmentsDir, row.document_id);
  const abs = path.resolve(dataDir, row.file_path);

  // Must be strictly constrained to the owning document's attachments directory
  if (!abs.startsWith(docAttachmentsDir + path.sep) && abs !== docAttachmentsDir) {
    throw new HttpError(403, `Attachment path outside owning document directory: ${row.file_path}`);
  }
  return abs;
}

export function readAttachmentBytes(row: AttachmentRow): Buffer {
  const abs = resolveAttachmentFilesystem(row);
  return readFileSync(abs);
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
  if (!SAFE_ID_REGEX.test(docId)) {
    throw new HttpError(400, "Invalid document ID format");
  }
  const normalizedMime = (mimeType || "").toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
    throw new HttpError(400, `Unsupported image MIME type: ${mimeType}`);
  }
  if (!data || data.length === 0) {
    throw new HttpError(400, "Empty file attachment");
  }

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
    normalizedMime,
    relativePath,
    sha256,
    createdAt,
  );

  return getAttachment(docId, id)!;
}

/**
 * Strips dataURL Base64 payloads from scene.files, writes any new binary files
 * atomically to /data/attachments/<docId>/<fileId>, records metadata in the
 * attachments table, and drops unreferenced files from the stored scene.
 *
 * Guaranteed atomic cleanup: if writing or DB persistence fails, any newly
 * written disk files during this call (including restored missing files) are
 * immediately cleaned up.
 */
export function compactSceneFiles(docId: string, scene: ExcalidrawScene): ExcalidrawScene {
  if (!scene) return scene;

  if (!SAFE_ID_REGEX.test(docId)) {
    throw new HttpError(400, "Invalid document ID format");
  }

  // 1. Collect all live (undeleted) image element fileIds
  const referencedFileIds = new Set<string>();
  if (Array.isArray(scene.elements)) {
    for (const el of scene.elements as Record<string, unknown>[]) {
      if (el && el.type === "image" && !el.isDeleted && typeof el.fileId === "string") {
        referencedFileIds.add(el.fileId);
      }
    }
  }

  if (!scene.files || typeof scene.files !== "object" || Object.keys(scene.files).length === 0) {
    return { ...scene, files: {} };
  }

  const db = getDb();
  const cfg = config();
  const dir = path.join(cfg.attachmentsDir, docId);
  mkdirSync(dir, { recursive: true });

  const compactFiles: Record<string, unknown> = {};
  const newlyCreatedFiles: string[] = [];

  try {
    for (const [fileId, fileObj] of Object.entries(scene.files as Record<string, Record<string, unknown>>)) {
      if (!fileObj || typeof fileObj !== "object") continue;

      // Retain only files referenced by live image elements
      if (!referencedFileIds.has(fileId)) continue;

      if (!SAFE_ID_REGEX.test(fileId)) {
        throw new HttpError(400, `Invalid fileId format: ${fileId}`);
      }

      const mimeType = String(fileObj.mimeType || "image/png").toLowerCase();
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new HttpError(400, `Unsupported image MIME type: ${mimeType}`);
      }

      const dataURL = fileObj.dataURL;
      if (typeof dataURL === "string" && dataURL.startsWith("data:")) {
        const match = dataURL.match(/^data:([^;]+);base64,(.*)$/s);
        if (!match) {
          throw new HttpError(400, `Invalid dataURL format for file: ${fileId}`);
        }
        const extractedMime = match[1].toLowerCase();
        if (!ALLOWED_MIME_TYPES.has(extractedMime)) {
          throw new HttpError(400, `Unsupported image MIME type: ${extractedMime}`);
        }

        const rawBase64 = match[2].trim();
        if (rawBase64.length === 0) {
          throw new HttpError(400, `Empty Base64 payload for file: ${fileId}`);
        }
        if (!isValidBase64String(rawBase64)) {
          throw new HttpError(400, `Invalid Base64 syntax for file: ${fileId}`);
        }

        const buffer = Buffer.from(rawBase64, "base64");
        if (buffer.length === 0) {
          throw new HttpError(400, `Empty decoded image buffer for file: ${fileId}`);
        }

        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const relativePath = path.posix.join("attachments", docId, fileId).replace(/\//g, path.sep);
        const finalAbs = path.join(cfg.dataDir, relativePath);

        const existing = getAttachment(docId, fileId);
        if (existing) {
          if (existing.sha256 && existing.sha256 !== sha256) {
            throw new HttpError(400, `Attachment content mismatch for existing fileId in document: ${fileId}`);
          }
          if (!existsSync(finalAbs)) {
            // Atomic write for missing file recovery
            const tempAbs = path.join(dir, `${fileId}.tmp.${randomUUID()}`);
            writeFileSync(tempAbs, buffer);
            renameSync(tempAbs, finalAbs);
            newlyCreatedFiles.push(finalAbs);
          }
        } else {
          // Atomic write via temporary file -> rename
          const tempAbs = path.join(dir, `${fileId}.tmp.${randomUUID()}`);
          writeFileSync(tempAbs, buffer);
          renameSync(tempAbs, finalAbs);
          newlyCreatedFiles.push(finalAbs);

          db.prepare(
            `INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            fileId,
            docId,
            fileId,
            buffer.length,
            extractedMime,
            relativePath,
            sha256,
            new Date().toISOString(),
          );
        }
      }

      // Omit dataURL from the stored compact scene
      compactFiles[fileId] = {
        id: fileId,
        mimeType: fileObj.mimeType || mimeType,
        created: fileObj.created || Date.now(),
        ...(fileObj.version ? { version: fileObj.version } : {}),
      };
    }

    return {
      ...scene,
      files: compactFiles,
    };
  } catch (err) {
    // Roll back any newly written files on disk on failure
    for (const f of newlyCreatedFiles) {
      try {
        rmSync(f, { force: true });
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/**
 * Restores dataURL Base64 payloads into scene.files by reading attachment files
 * from disk. Result is held in memory for Excalidraw rendering/export only.
 *
 * Validates fileId and document boundaries before any disk read.
 */
export function hydrateSceneFiles(docId: string, scene: ExcalidrawScene): ExcalidrawScene {
  if (!scene || !scene.files || typeof scene.files !== "object") {
    return scene;
  }

  if (!SAFE_ID_REGEX.test(docId)) {
    return scene;
  }

  const hydratedFiles: Record<string, unknown> = {};
  const dataDir = path.resolve(config().dataDir);
  const docAttachmentsDir = path.resolve(config().attachmentsDir, docId);

  for (const [fileId, fileObj] of Object.entries(scene.files as Record<string, Record<string, unknown>>)) {
    if (!fileObj || typeof fileObj !== "object") continue;

    // If dataURL is already populated, retain it
    if (typeof fileObj.dataURL === "string" && fileObj.dataURL.length > 0) {
      hydratedFiles[fileId] = fileObj;
      continue;
    }

    if (!SAFE_ID_REGEX.test(fileId)) {
      hydratedFiles[fileId] = fileObj;
      continue;
    }

    const row = getAttachment(docId, fileId);
    if (row) {
      if (row.document_id !== docId) {
        throw new HttpError(403, "Attachment does not belong to document");
      }
      try {
        const abs = resolveAttachmentFilesystem(row);
        if (path.resolve(abs).startsWith(dataDir + path.sep)) {
          const bytes = readFileSync(abs);
          hydratedFiles[fileId] = {
            ...fileObj,
            dataURL: `data:${row.mime_type};base64,${bytes.toString("base64")}`,
          };
          continue;
        }
      } catch {
        // Fallback to disk lookup
      }
    }

    // Safe disk fallback lookup under /data/attachments/<docId>/<fileId>
    const diskPath = path.resolve(docAttachmentsDir, fileId);
    if (diskPath.startsWith(docAttachmentsDir + path.sep) && existsSync(diskPath)) {
      try {
        const bytes = readFileSync(diskPath);
        const mime = String(fileObj.mimeType || "image/png");
        hydratedFiles[fileId] = {
          ...fileObj,
          dataURL: `data:${mime};base64,${bytes.toString("base64")}`,
        };
        continue;
      } catch {
        // ignore
      }
    }

    hydratedFiles[fileId] = fileObj;
  }

  return {
    ...scene,
    files: hydratedFiles,
  };
}

/**
 * Removes attachment records and files that are no longer referenced in the
 * active document scene nor in any surviving recovery snapshot for this document.
 */
export function gcUnreferencedAttachments(docId: string): void {
  if (!SAFE_ID_REGEX.test(docId)) return;

  const referencedFileIds = new Set<string>();

  function collectFromScene(rawJson: string | null | undefined) {
    if (!rawJson) return;
    try {
      const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
      if (parsed && Array.isArray(parsed.elements)) {
        for (const el of parsed.elements) {
          if (el && el.type === "image" && !el.isDeleted && typeof el.fileId === "string") {
            referencedFileIds.add(el.fileId);
          }
        }
      }
      if (parsed && parsed.files && typeof parsed.files === "object") {
        for (const fId of Object.keys(parsed.files)) {
          referencedFileIds.add(fId);
        }
      }
    } catch {
      // ignore
    }
  }

  // 1. Collect from active document
  const doc = getDocumentRaw(docId);
  if (doc) {
    collectFromScene(doc.scene);
  }

  // 2. Collect from all surviving version snapshots
  const versions = getDb()
    .prepare("SELECT scene FROM document_versions WHERE document_id = ?")
    .all(docId) as { scene: string }[];
  for (const v of versions) {
    collectFromScene(v.scene);
  }

  // 3. Compare with attachments table for this document
  const attachments = listAttachments(docId);
  for (const att of attachments) {
    if (!referencedFileIds.has(att.id)) {
      getDb().prepare("DELETE FROM attachments WHERE document_id = ? AND id = ?").run(docId, att.id);
      try {
        const abs = resolveAttachmentFilesystem(att);
        rmSync(abs, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Delete an attachment's physical file only when no longer referenced by the
 * current scene or any preserved snapshot (version-safe retention).
 */
export function deleteAttachmentIfUnreferenced(docId: string, attachmentId: string): boolean {
  gcUnreferencedAttachments(docId);
  return getAttachment(docId, attachmentId) === undefined;
}

/** Force-remove an attachment regardless of references (used on permanent delete). */
export function forceDeleteAttachment(attachmentId: string, docId?: string): void {
  const row = getAttachmentById(attachmentId, docId);
  if (!row) return;
  getDb().prepare("DELETE FROM attachments WHERE document_id = ? AND id = ?").run(row.document_id, attachmentId);
  try {
    rmSync(resolveAttachmentFilesystem(row), { force: true });
  } catch {
    // ignore
  }
}