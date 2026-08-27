import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { config } from "./config";

export interface StorageItemMetrics {
  fileCount: number;
  byteSize: number;
}

export interface SqliteMetrics {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  reclaimableBytes: number;
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
}

export interface OrphanFileItem {
  type: "attachment" | "thumbnail";
  relativePath: string;
  absolutePath: string;
  byteSize: number;
  modifiedAt: string;
}

export interface MissingFileItem {
  type: "attachment" | "thumbnail";
  id?: string;
  documentId?: string;
  fileId?: string;
  versionNumber?: number;
  expectedRelativePath: string;
  byteSize?: number;
}

export interface UnreferencedAttachmentItem {
  documentId: string;
  attachmentId: string;
  fileName: string;
  filePath: string;
  byteSize: number;
  createdAt: string;
  ageSeconds: number;
}

export interface UnreferencedAttachmentsReport {
  items: UnreferencedAttachmentItem[];
  totalCount: number;
  totalBytes: number;
  gracePeriodSeconds: number;
}

export interface StorageScanReport {
  database: SqliteMetrics;
  attachments: StorageItemMetrics;
  thumbnails: StorageItemMetrics;
  totalStorageBytes: number;
  legacyScenes: {
    documentsCount: number;
    versionsCount: number;
    totalCount: number;
  };
  orphans: {
    items: OrphanFileItem[];
    totalCount: number;
    totalBytes: number;
  };
  missingFiles: {
    items: MissingFileItem[];
    totalCount: number;
  };
  unreferencedAttachments: UnreferencedAttachmentsReport;
  scannedAt: string;
}

export interface CleanupResult {
  deletedFiles: string[];
  reclaimedBytes: number;
  errors?: string[];
  scannedAt: string;
}

export interface CleanUnreferencedResult {
  deletedRows: number;
  deletedFiles: string[];
  reclaimedBytes: number;
  warnings?: string[];
  scannedAt: string;
}

export interface VacuumResult {
  before: SqliteMetrics;
  after: SqliteMetrics;
  reclaimedBytes: number;
  timestamp: string;
}

export const UNREFERENCED_GRACE_PERIOD_SECONDS = 86400; // 24 hours

/**
 * Retrieve SQLite page, freelist, and database file byte metrics.
 */
export function getSqliteMetrics(): SqliteMetrics {
  const cfg = config();
  const db = getDb();

  let pageSize = 4096;
  let pageCount = 0;
  let freelistCount = 0;

  try {
    const pSize = db.prepare("PRAGMA page_size;").get() as Record<string, unknown> | undefined;
    if (pSize && typeof pSize.page_size === "number") {
      pageSize = pSize.page_size;
    }
    const pCount = db.prepare("PRAGMA page_count;").get() as Record<string, unknown> | undefined;
    if (pCount && typeof pCount.page_count === "number") {
      pageCount = pCount.page_count;
    }
    const fCount = db.prepare("PRAGMA freelist_count;").get() as Record<string, unknown> | undefined;
    if (fCount && typeof fCount.freelist_count === "number") {
      freelistCount = fCount.freelist_count;
    }
  } catch {
    // Ignore PRAGMA read errors if any
  }

  let dbBytes = 0;
  let walBytes = 0;
  let shmBytes = 0;

  try {
    if (fs.existsSync(cfg.dbPath)) {
      dbBytes = fs.statSync(cfg.dbPath).size;
    }
  } catch {
    // Ignore stat error
  }

  const walPath = `${cfg.dbPath}-wal`;
  try {
    if (fs.existsSync(walPath)) {
      walBytes = fs.statSync(walPath).size;
    }
  } catch {
    // Ignore stat error
  }

  const shmPath = `${cfg.dbPath}-shm`;
  try {
    if (fs.existsSync(shmPath)) {
      shmBytes = fs.statSync(shmPath).size;
    }
  } catch {
    // Ignore stat error
  }

  return {
    pageSize,
    pageCount,
    freelistCount,
    reclaimableBytes: freelistCount * pageSize,
    dbBytes,
    walBytes,
    shmBytes,
  };
}

/**
 * Perform a full read-only scan of the storage state:
 * - SQLite and journal metrics
 * - Attachment and thumbnail disk totals
 * - Legacy inline image scene counts
 * - Filesystem orphan candidates (never deleting or modifying anything)
 * - Missing disk files referenced in DB rows (reporting only, never deleting rows)
 */
export function scanStorage(): StorageScanReport {
  const cfg = config();
  const db = getDb();
  const dbMetrics = getSqliteMetrics();

  // 1. Scan attachments on disk
  let attachmentsCount = 0;
  let attachmentsBytes = 0;
  const orphanItems: OrphanFileItem[] = [];

  const activeAttachments = db
    .prepare("SELECT document_id, id FROM attachments;")
    .all() as { document_id: string; id: string }[];
  const attachmentSet = new Set(activeAttachments.map((a) => `${a.document_id}/${a.id}`));

  const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);
  if (fs.existsSync(resolvedAttachmentsDir)) {
    try {
      const docDirs = fs.readdirSync(resolvedAttachmentsDir);
      for (const docDir of docDirs) {
        const docDirPath = path.join(resolvedAttachmentsDir, docDir);
        try {
          const dirStat = fs.lstatSync(docDirPath);
          if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;

          const fileEntries = fs.readdirSync(docDirPath);
          for (const fileEntry of fileEntries) {
            const filePath = path.join(docDirPath, fileEntry);
            try {
              const fileStat = fs.lstatSync(filePath);
              if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;

              attachmentsCount += 1;
              attachmentsBytes += fileStat.size;

              const key = `${docDir}/${fileEntry}`;
              if (!attachmentSet.has(key)) {
                orphanItems.push({
                  type: "attachment",
                  relativePath: `attachments/${docDir}/${fileEntry}`,
                  absolutePath: filePath,
                  byteSize: fileStat.size,
                  modifiedAt: fileStat.mtime.toISOString(),
                });
              }
            } catch {
              // Ignore unreadable file
            }
          }
        } catch {
          // Ignore unreadable dir
        }
      }
    } catch {
      // Ignore readdir error
    }
  }

  // 2. Scan thumbnails on disk
  let thumbnailsCount = 0;
  let thumbnailsBytes = 0;

  const docThumbnails = db
    .prepare("SELECT id, thumbnail_path FROM documents;")
    .all() as { id: string; thumbnail_path: string | null }[];
  const versionThumbnails = db
    .prepare("SELECT thumbnail_path FROM document_versions WHERE thumbnail_path IS NOT NULL;")
    .all() as { thumbnail_path: string }[];

  const validThumbnailPaths = new Set<string>();
  for (const d of docThumbnails) {
    if (d.thumbnail_path) {
      validThumbnailPaths.add(path.normalize(d.thumbnail_path).replace(/\\/g, "/"));
    }
    // Also consider standard document thumbnail name valid if document exists
    validThumbnailPaths.add(`thumbnails/${d.id}.png`);
    validThumbnailPaths.add(`${d.id}.png`);
  }
  for (const v of versionThumbnails) {
    if (v.thumbnail_path) {
      validThumbnailPaths.add(path.normalize(v.thumbnail_path).replace(/\\/g, "/"));
    }
  }

  const resolvedThumbnailsDir = path.resolve(cfg.thumbnailsDir);
  if (fs.existsSync(resolvedThumbnailsDir)) {
    try {
      const thumbEntries = fs.readdirSync(resolvedThumbnailsDir);
      for (const thumbEntry of thumbEntries) {
        const thumbPath = path.join(resolvedThumbnailsDir, thumbEntry);
        try {
          const stat = fs.lstatSync(thumbPath);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;

          thumbnailsCount += 1;
          thumbnailsBytes += stat.size;

          const rel1 = `thumbnails/${thumbEntry}`;
          const rel2 = thumbEntry;
          if (!validThumbnailPaths.has(rel1) && !validThumbnailPaths.has(rel2)) {
            orphanItems.push({
              type: "thumbnail",
              relativePath: `thumbnails/${thumbEntry}`,
              absolutePath: thumbPath,
              byteSize: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            });
          }
        } catch {
          // Ignore unreadable file
        }
      }
    } catch {
      // Ignore readdir error
    }
  }

  // 3. Scan for missing files referenced in DB rows (reporting only, NEVER delete rows)
  const missingItems: MissingFileItem[] = [];

  const allAttachmentRows = db
    .prepare("SELECT id, document_id, file_name, file_size, file_path FROM attachments;")
    .all() as { id: string; document_id: string; file_name: string; file_size: number; file_path: string }[];

  for (const att of allAttachmentRows) {
    const expectedDiskPath = path.join(resolvedAttachmentsDir, att.document_id, att.id);
    if (!fs.existsSync(expectedDiskPath)) {
      missingItems.push({
        type: "attachment",
        id: att.id,
        documentId: att.document_id,
        fileId: att.id,
        expectedRelativePath: `attachments/${att.document_id}/${att.id}`,
        byteSize: att.file_size,
      });
    }
  }

  for (const doc of docThumbnails) {
    if (doc.thumbnail_path) {
      const safe = path.normalize(doc.thumbnail_path);
      const abs = safe.startsWith("thumbnails" + path.sep) || safe.startsWith("thumbnails/")
        ? path.join(cfg.dataDir, safe)
        : path.join(cfg.thumbnailsDir, safe);
      if (!fs.existsSync(abs)) {
        missingItems.push({
          type: "thumbnail",
          id: doc.id,
          documentId: doc.id,
          expectedRelativePath: doc.thumbnail_path,
        });
      }
    }
  }

  const allVersionThumbnails = db
    .prepare("SELECT id, document_id, version_number, thumbnail_path FROM document_versions WHERE thumbnail_path IS NOT NULL;")
    .all() as { id: string; document_id: string; version_number: number; thumbnail_path: string }[];

  for (const ver of allVersionThumbnails) {
    const safe = path.normalize(ver.thumbnail_path);
    const abs = safe.startsWith("thumbnails" + path.sep) || safe.startsWith("thumbnails/")
      ? path.join(cfg.dataDir, safe)
      : path.join(cfg.thumbnailsDir, safe);
    if (!fs.existsSync(abs)) {
      missingItems.push({
        type: "thumbnail",
        id: ver.id,
        documentId: ver.document_id,
        versionNumber: ver.version_number,
        expectedRelativePath: ver.thumbnail_path,
      });
    }
  }

  // 4. Scan legacy inline scenes (dataURL / data:image/)
  let legacyDocCount = 0;
  let legacyVerCount = 0;

  try {
    const docs = db.prepare("SELECT scene FROM documents;").all() as { scene: string }[];
    for (const d of docs) {
      if (d.scene && (d.scene.includes('"data:image/') || d.scene.includes('"dataURL":'))) {
        legacyDocCount += 1;
      }
    }
    const vers = db.prepare("SELECT scene FROM document_versions;").all() as { scene: string }[];
    for (const v of vers) {
      if (v.scene && (v.scene.includes('"data:image/') || v.scene.includes('"dataURL":'))) {
        legacyVerCount += 1;
      }
    }
  } catch {
    // Ignore query error
  }

  // 5. Scan Tier 2 unreferenced DB attachment rows (>24h grace period, absent from active + version scenes)
  const referencedAttachmentKeys = new Set<string>(); // set of `${document_id}:${fileId}`

  try {
    const docs = db.prepare("SELECT id, scene FROM documents;").all() as { id: string; scene: string | null }[];
    for (const doc of docs) {
      if (doc.scene) {
        try {
          const parsed = JSON.parse(doc.scene);
          if (parsed.files && typeof parsed.files === "object") {
            for (const fileId of Object.keys(parsed.files)) {
              referencedAttachmentKeys.add(`${doc.id}:${fileId}`);
            }
          }
        } catch {
          // Ignore JSON parse error
        }
      }
    }

    const versions = db.prepare("SELECT document_id, scene FROM document_versions;").all() as { document_id: string; scene: string | null }[];
    for (const ver of versions) {
      if (ver.scene) {
        try {
          const parsed = JSON.parse(ver.scene);
          if (parsed.files && typeof parsed.files === "object") {
            for (const fileId of Object.keys(parsed.files)) {
              referencedAttachmentKeys.add(`${ver.document_id}:${fileId}`);
            }
          }
        } catch {
          // Ignore JSON parse error
        }
      }
    }
  } catch {
    // Ignore query error
  }

  const unreferencedItems: UnreferencedAttachmentItem[] = [];
  const nowMs = Date.now();

  try {
    const allAttachments = db.prepare("SELECT id, document_id, file_name, file_size, file_path, created_at FROM attachments;").all() as {
      id: string;
      document_id: string;
      file_name: string;
      file_size: number;
      file_path: string;
      created_at: string;
    }[];

    for (const att of allAttachments) {
      const refKey = `${att.document_id}:${att.id}`;
      if (!referencedAttachmentKeys.has(refKey)) {
        const createdMs = new Date(att.created_at).getTime();
        const ageSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
        if (ageSeconds >= UNREFERENCED_GRACE_PERIOD_SECONDS) {
          unreferencedItems.push({
            documentId: att.document_id,
            attachmentId: att.id,
            fileName: att.file_name,
            filePath: att.file_path,
            byteSize: att.file_size,
            createdAt: att.created_at,
            ageSeconds,
          });
        }
      }
    }
  } catch {
    // Ignore query error
  }

  const totalUnreferencedBytes = unreferencedItems.reduce((acc, item) => acc + item.byteSize, 0);
  const totalOrphanBytes = orphanItems.reduce((acc, item) => acc + item.byteSize, 0);
  const totalStorageBytes =
    dbMetrics.dbBytes +
    dbMetrics.walBytes +
    dbMetrics.shmBytes +
    attachmentsBytes +
    thumbnailsBytes;

  return {
    database: dbMetrics,
    attachments: {
      fileCount: attachmentsCount,
      byteSize: attachmentsBytes,
    },
    thumbnails: {
      fileCount: thumbnailsCount,
      byteSize: thumbnailsBytes,
    },
    totalStorageBytes,
    legacyScenes: {
      documentsCount: legacyDocCount,
      versionsCount: legacyVerCount,
      totalCount: legacyDocCount + legacyVerCount,
    },
    orphans: {
      items: orphanItems,
      totalCount: orphanItems.length,
      totalBytes: totalOrphanBytes,
    },
    missingFiles: {
      items: missingItems,
      totalCount: missingItems.length,
    },
    unreferencedAttachments: {
      items: unreferencedItems,
      totalCount: unreferencedItems.length,
      totalBytes: totalUnreferencedBytes,
      gracePeriodSeconds: UNREFERENCED_GRACE_PERIOD_SECONDS,
    },
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Explicit confirmed cleanup of orphan files on disk:
 * - Rescans immediately before deletion to prevent race conditions.
 * - Only deletes regular files strictly under dataDir/attachments and dataDir/thumbnails absent from DB.
 * - Never follows or deletes symlinks.
 * - Never deletes DB rows for missing files.
 */
export function cleanOrphans(confirm: boolean): CleanupResult {
  if (!confirm) {
    throw new Error("Explicit confirmation required for storage cleanup");
  }

  const cfg = config();
  const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);
  const resolvedThumbnailsDir = path.resolve(cfg.thumbnailsDir);

  // Immediate rescan before execution
  const scan = scanStorage();
  const deletedFiles: string[] = [];
  let reclaimedBytes = 0;
  const errors: string[] = [];

  for (const orphan of scan.orphans.items) {
    try {
      const resolved = path.resolve(orphan.absolutePath);

      // Strict boundary check: must be located inside attachmentsDir or thumbnailsDir
      const inAttachments = resolved.startsWith(resolvedAttachmentsDir + path.sep);
      const inThumbnails = resolved.startsWith(resolvedThumbnailsDir + path.sep);

      if (!inAttachments && !inThumbnails) {
        errors.push(`File ${orphan.relativePath} is outside allowed data directories`);
        continue;
      }

      if (!fs.existsSync(resolved)) continue;

      const stat = fs.lstatSync(resolved);
      // Never delete or follow symlinks
      if (stat.isSymbolicLink() || !stat.isFile()) {
        errors.push(`File ${orphan.relativePath} is a symlink or not a regular file`);
        continue;
      }

      const size = stat.size;
      fs.unlinkSync(resolved);
      reclaimedBytes += size;
      deletedFiles.push(orphan.relativePath);

      // If this was an attachment file, clean up parent directory if empty
      if (inAttachments) {
        const parentDir = path.dirname(resolved);
        try {
          if (fs.readdirSync(parentDir).length === 0) {
            fs.rmdirSync(parentDir);
          }
        } catch {
          // Ignore rmdir error if not empty
        }
      }
    } catch (err) {
      errors.push(`Failed to delete ${orphan.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    deletedFiles,
    reclaimedBytes,
    errors: errors.length > 0 ? errors : undefined,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Explicit confirmed SQLite VACUUM operation.
 * Reclaims free SQLite pages.
 * Never called automatically on startup.
 */
export function runVacuum(confirm: boolean): VacuumResult {
  if (!confirm) {
    throw new Error("Explicit confirmation required for SQLite VACUUM");
  }

  const before = getSqliteMetrics();
  const db = getDb();
  db.exec("VACUUM;");
  const after = getSqliteMetrics();

  const reclaimedBytes = Math.max(0, before.dbBytes - after.dbBytes);

  return {
    before,
    after,
    reclaimedBytes,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Explicit confirmed cleanup of Tier 2 unreferenced attachment rows and physical files:
 * - Rescans immediately before execution to prevent race conditions.
 * - Only cleans attachment rows older than the 24-hour grace period unreferenced by any scene or retained version.
 * - For each candidate: deletes regular disk file (never symlinks), deletes DB row, and cleans parent directory if empty.
 * - If physical file is missing or a symlink: skips deletion, preserves DB row, and logs warning result.
 */
export function cleanUnreferencedAttachments(confirm: boolean): CleanUnreferencedResult {
  if (!confirm) {
    throw new Error("Explicit confirmation required for unreferenced attachments cleanup");
  }

  const cfg = config();
  const db = getDb();
  const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);

  // Immediate rescan before execution to prevent race conditions
  const scan = scanStorage();
  const deletedFiles: string[] = [];
  let deletedRows = 0;
  let reclaimedBytes = 0;
  const warnings: string[] = [];

  for (const item of scan.unreferencedAttachments.items) {
    try {
      const diskPath = path.resolve(resolvedAttachmentsDir, item.documentId, item.attachmentId);

      // Must be strictly inside attachmentsDir
      if (!diskPath.startsWith(resolvedAttachmentsDir + path.sep)) {
        warnings.push(`Attachment ${item.documentId}/${item.attachmentId} path is outside allowed attachments directory`);
        continue;
      }

      // Check physical existence on disk
      if (!fs.existsSync(diskPath)) {
        warnings.push(`Attachment file missing on disk for row ${item.documentId}/${item.attachmentId}; row preserved`);
        continue;
      }

      const stat = fs.lstatSync(diskPath);
      // Symlink check: do NOT delete symlink or delete DB row if it's a symlink
      if (stat.isSymbolicLink() || !stat.isFile()) {
        warnings.push(`Attachment file ${item.documentId}/${item.attachmentId} is a symlink or not a regular file; row preserved`);
        continue;
      }

      const size = stat.size;
      fs.unlinkSync(diskPath);
      deletedFiles.push(`attachments/${item.documentId}/${item.attachmentId}`);
      reclaimedBytes += size;

      // Delete DB row
      db.prepare("DELETE FROM attachments WHERE document_id = ? AND id = ?;").run(item.documentId, item.attachmentId);
      deletedRows += 1;

      // Clean empty doc dir if empty
      const parentDir = path.dirname(diskPath);
      try {
        if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
          fs.rmdirSync(parentDir);
        }
      } catch {
        // ignore
      }
    } catch (err) {
      warnings.push(`Failed to clean unreferenced attachment ${item.documentId}/${item.attachmentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    deletedRows,
    deletedFiles,
    reclaimedBytes,
    warnings: warnings.length > 0 ? warnings : undefined,
    scannedAt: new Date().toISOString(),
  };
}
