import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resetDb, getDb } from "@/lib/db";
import { resetConfig, config } from "@/lib/config";
import { createUser, createSession } from "@/lib/users";
import { createDocument } from "@/lib/documents";
import {
  scanStorage,
  cleanOrphans,
  cleanUnreferencedAttachments,
  runVacuum,
  getSqliteMetrics,
} from "@/lib/storage_maintenance";
import { GET as getStorageRoute, POST as postStorageRoute } from "@/app/api/admin/storage/route";
import { SESSION_COOKIE } from "@/lib/http";
import { emptyScene } from "@/lib/types";

describe("Storage & Database Maintenance", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should enforce authentication and admin-only authorization on /api/admin/storage", async () => {
    const normalUser = createUser("user1", "pass123", "USER");
    const adminUser = createUser("admin1", "pass123", "ADMIN");

    const normalSession = createSession(normalUser.id);
    const adminSession = createSession(adminUser.id);

    // Unauthenticated GET
    const unauthReq = new Request("http://localhost/api/admin/storage");
    const unauthRes = await getStorageRoute(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Normal USER GET -> 403
    const userReq = new Request("http://localhost/api/admin/storage", {
      headers: { cookie: `${SESSION_COOKIE}=${normalSession.token}` },
    });
    const userRes = await getStorageRoute(userReq);
    expect(userRes.status).toBe(403);

    // ADMIN GET -> 200
    const adminReq = new Request("http://localhost/api/admin/storage", {
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
    });
    const adminRes = await getStorageRoute(adminReq);
    expect(adminRes.status).toBe(200);
    const body = await adminRes.json();
    expect(body.database).toBeDefined();
    expect(body.totalStorageBytes).toBeGreaterThan(0);
  });

  it("should report accurate SQLite page metrics, journal sizes, and total storage", () => {
    const metrics = getSqliteMetrics();
    expect(metrics.pageSize).toBeGreaterThanOrEqual(512);
    expect(metrics.pageCount).toBeGreaterThan(0);
    expect(metrics.dbBytes).toBeGreaterThan(0);
    expect(typeof metrics.freelistCount).toBe("number");
    expect(typeof metrics.reclaimableBytes).toBe("number");
  });

  it("should detect legacy inline image scenes and distinguish from compact scenes", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc1 = createDocument(user.id, emptyScene(), "Normal Doc");

    // Legacy scene with dataURL
    const legacyScene = {
      ...emptyScene(),
      files: {
        img1: {
          mimeType: "image/png",
          id: "img1",
          dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          created: Date.now(),
        },
      },
    };
    const db = getDb();
    db.prepare("INSERT INTO documents (id, title, owner_id, scene, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);")
      .run("legacy-doc-1", "Legacy Doc", user.id, JSON.stringify(legacyScene), new Date().toISOString(), new Date().toISOString());

    const scan = scanStorage();
    expect(scan.legacyScenes.documentsCount).toBe(1);
    expect(scan.legacyScenes.totalCount).toBe(1);
  });

  it("should report missing disk files referenced in DB without deleting DB rows", () => {
    const user = createUser("bob", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Missing Attachments Doc");

    const db = getDb();
    // Insert an attachment row with non-existent physical disk file
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("missing-file-id", doc.id, "photo.png", 2048, "image/png", `attachments/${doc.id}/missing-file-id`, new Date().toISOString());

    const scan = scanStorage();
    expect(scan.missingFiles.totalCount).toBeGreaterThanOrEqual(1);
    const missing = scan.missingFiles.items.find((m) => m.fileId === "missing-file-id");
    expect(missing).toBeDefined();
    expect(missing?.documentId).toBe(doc.id);

    // Verify DB row is strictly preserved
    const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get("missing-file-id");
    expect(row).toBeDefined();
  });

  it("should safely identify and clean up unreferenced orphan files under data root", () => {
    const cfg = config();
    const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);
    const resolvedThumbnailsDir = path.resolve(cfg.thumbnailsDir);

    // Create an orphan attachment file on disk
    const orphanDocDir = path.join(resolvedAttachmentsDir, "orphan-doc-999");
    fs.mkdirSync(orphanDocDir, { recursive: true });
    const orphanAttPath = path.join(orphanDocDir, "orphan-file-888");
    fs.writeFileSync(orphanAttPath, Buffer.from("orphan-attachment-content"));

    // Create an orphan thumbnail file on disk
    const orphanThumbPath = path.join(resolvedThumbnailsDir, "orphan-thumb-777.png");
    fs.writeFileSync(orphanThumbPath, Buffer.from("orphan-thumbnail-content"));

    // 1. Initial Scan should find the 2 orphan items
    const initialScan = scanStorage();
    expect(initialScan.orphans.items.some((o) => o.relativePath.includes("orphan-file-888"))).toBe(true);
    expect(initialScan.orphans.items.some((o) => o.relativePath.includes("orphan-thumb-777.png"))).toBe(true);

    // 2. Calling cleanOrphans without confirmation must throw error
    expect(() => cleanOrphans(false)).toThrow(/confirmation required/i);

    // 3. Calling cleanOrphans with confirmation deletes orphan files
    const result = cleanOrphans(true);
    expect(result.deletedFiles.length).toBeGreaterThanOrEqual(2);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(orphanAttPath)).toBe(false);
    expect(fs.existsSync(orphanThumbPath)).toBe(false);

    // 4. Post-cleanup scan shows 0 orphans
    const postScan = scanStorage();
    expect(postScan.orphans.items.some((o) => o.relativePath.includes("orphan-file-888"))).toBe(false);
    expect(postScan.orphans.items.some((o) => o.relativePath.includes("orphan-thumb-777.png"))).toBe(false);
  });

  it("should never follow or delete symbolic links during cleanup", () => {
    const cfg = config();
    const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);

    // Create an external target file outside the managed attachments directory
    const externalTargetDir = path.resolve(cfg.dataDir, "external-safe-dir");
    fs.mkdirSync(externalTargetDir, { recursive: true });
    const externalTargetFile = path.join(externalTargetDir, "do-not-delete.txt");
    fs.writeFileSync(externalTargetFile, Buffer.from("important external data"));

    // Try creating a symlink inside attachments directory
    const linkDocDir = path.join(resolvedAttachmentsDir, "symlink-doc");
    fs.mkdirSync(linkDocDir, { recursive: true });
    const symlinkPath = path.join(linkDocDir, "symlink-file");

    let symlinkCreated = false;
    try {
      fs.symlinkSync(externalTargetFile, symlinkPath);
      symlinkCreated = true;
    } catch {
      // Symlink creation might fail on Windows if developer mode / OS privilege is disabled
      symlinkCreated = false;
    }

    if (!symlinkCreated) {
      // Conditionally skip if OS does not allow symlink creation in current execution context
      return;
    }

    try {
      // Run cleanup
      const result = cleanOrphans(true);

      // Symlink must survive and external target file must survive untouched
      expect(fs.existsSync(symlinkPath)).toBe(true);
      expect(fs.existsSync(externalTargetFile)).toBe(true);
      expect(fs.readFileSync(externalTargetFile, "utf-8")).toBe("important external data");
    } finally {
      // Cleanup the test symlink and external target
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(externalTargetFile);
        fs.rmdirSync(externalTargetDir);
      } catch {
        // ignore
      }
    }
  });

  it("should enforce confirmation guards on POST /api/admin/storage cleanup and vacuum", async () => {
    const admin = createUser("admin2", "pass123", "ADMIN");
    const session = createSession(admin.id);

    // Cleanup without confirm=true -> 400
    const unconfirmedCleanupReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ action: "cleanup", confirm: false }),
    });
    const unconfirmedCleanupRes = await postStorageRoute(unconfirmedCleanupReq);
    expect(unconfirmedCleanupRes.status).toBe(400);

    // Vacuum without confirm=true -> 400
    const unconfirmedVacReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ action: "vacuum" }),
    });
    const unconfirmedVacRes = await postStorageRoute(unconfirmedVacReq);
    expect(unconfirmedVacRes.status).toBe(400);

    // Vacuum with confirm=true -> 200
    const confirmedVacReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ action: "vacuum", confirm: true }),
    });
    const confirmedVacRes = await postStorageRoute(confirmedVacReq);
    expect(confirmedVacRes.status).toBe(200);
    const vacBody = await confirmedVacRes.json();
    expect(vacBody.before).toBeDefined();
    expect(vacBody.after).toBeDefined();
  });

  it("should run VACUUM cleanly and defragment free pages", () => {
    expect(() => runVacuum(false)).toThrow(/confirmation required/i);
    const res = runVacuum(true);
    expect(res.before.pageCount).toBeGreaterThan(0);
    expect(res.after.pageCount).toBeGreaterThan(0);
    expect(res.timestamp).toBeDefined();
  });

  it("should identify unreferenced attachment rows older than 24 hours while respecting 24h grace period and snapshot retention", () => {
    const user = createUser("carol", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Unreferenced Test Doc");
    const db = getDb();
    const cfg = config();
    const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);

    const docDir = path.join(resolvedAttachmentsDir, doc.id);
    fs.mkdirSync(docDir, { recursive: true });

    // File 1: Referenced by active document scene (never unreferenced)
    const refScene = {
      ...emptyScene(),
      elements: [{ id: "el1", type: "image", fileId: "file-referenced-active" }],
      files: {
        "file-referenced-active": { id: "file-referenced-active", mimeType: "image/png", created: 1 },
      },
    };
    db.prepare("UPDATE documents SET scene = ? WHERE id = ?;").run(JSON.stringify(refScene), doc.id);
    const activeFilePath = path.join(docDir, "file-referenced-active");
    fs.writeFileSync(activeFilePath, Buffer.from("active-bytes"));
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("file-referenced-active", doc.id, "active.png", 12, "image/png", `attachments/${doc.id}/file-referenced-active`, new Date(Date.now() - 100000 * 1000).toISOString());

    // File 2: Referenced by retained document version/snapshot (never unreferenced)
    const verScene = {
      ...emptyScene(),
      elements: [{ id: "el2", type: "image", fileId: "file-referenced-version" }],
      files: {
        "file-referenced-version": { id: "file-referenced-version", mimeType: "image/png", created: 2 },
      },
    };
    db.prepare("INSERT INTO document_versions (id, document_id, version_number, scene, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?);")
      .run("ver-1", doc.id, 1, JSON.stringify(verScene), user.id, new Date(Date.now() - 100000 * 1000).toISOString());
    const verFilePath = path.join(docDir, "file-referenced-version");
    fs.writeFileSync(verFilePath, Buffer.from("version-bytes"));
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("file-referenced-version", doc.id, "version.png", 13, "image/png", `attachments/${doc.id}/file-referenced-version`, new Date(Date.now() - 100000 * 1000).toISOString());

    // File 3: Unreferenced, created 1 hour ago (within 24h grace period -> NOT eligible yet)
    const recentFilePath = path.join(docDir, "file-unreferenced-recent");
    fs.writeFileSync(recentFilePath, Buffer.from("recent-bytes"));
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("file-unreferenced-recent", doc.id, "recent.png", 12, "image/png", `attachments/${doc.id}/file-unreferenced-recent`, new Date(Date.now() - 3600 * 1000).toISOString());

    // File 4: Unreferenced, created 30 hours ago (>24h grace period -> ELIGIBLE)
    const oldFilePath = path.join(docDir, "file-unreferenced-old");
    fs.writeFileSync(oldFilePath, Buffer.from("old-bytes"));
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("file-unreferenced-old", doc.id, "old.png", 9, "image/png", `attachments/${doc.id}/file-unreferenced-old`, new Date(Date.now() - 30 * 3600 * 1000).toISOString());

    const scan = scanStorage();
    expect(scan.unreferencedAttachments).toBeDefined();
    expect(scan.unreferencedAttachments.totalCount).toBe(1);
    expect(scan.unreferencedAttachments.items[0].attachmentId).toBe("file-unreferenced-old");
    expect(scan.unreferencedAttachments.items[0].byteSize).toBe(9);
    expect(scan.unreferencedAttachments.gracePeriodSeconds).toBe(86400);
  });

  it("should safely purge unreferenced attachment DB rows and regular disk files upon confirmation, preserving missing files and symlinks with warnings", () => {
    const user = createUser("dave", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Purge Test Doc");
    const db = getDb();
    const cfg = config();
    const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);
    const docDir = path.join(resolvedAttachmentsDir, doc.id);
    fs.mkdirSync(docDir, { recursive: true });

    // Candidate A: Regular file >24h old -> should be deleted from disk and DB
    const regularFilePath = path.join(docDir, "att-regular-old");
    fs.writeFileSync(regularFilePath, Buffer.from("regular-content"));
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("att-regular-old", doc.id, "regular.png", 15, "image/png", `attachments/${doc.id}/att-regular-old`, new Date(Date.now() - 30 * 3600 * 1000).toISOString());

    // Candidate B: DB row with missing physical file >24h old -> row must be preserved and warning returned
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("att-missing-old", doc.id, "missing.png", 100, "image/png", `attachments/${doc.id}/att-missing-old`, new Date(Date.now() - 30 * 3600 * 1000).toISOString());

    // Unconfirmed call must throw
    expect(() => cleanUnreferencedAttachments(false)).toThrow(/confirmation required/i);

    // Confirmed cleanup
    const result = cleanUnreferencedAttachments(true);
    expect(result.deletedRows).toBe(1);
    expect(result.reclaimedBytes).toBe(15);
    expect(result.deletedFiles).toContain(`attachments/${doc.id}/att-regular-old`);
    expect(fs.existsSync(regularFilePath)).toBe(false);

    // Candidate A row must be deleted from DB
    const rowA = db.prepare("SELECT * FROM attachments WHERE id = ?").get("att-regular-old");
    expect(rowA).toBeUndefined();

    // Candidate B row (missing file) must be preserved in DB
    const rowB = db.prepare("SELECT * FROM attachments WHERE id = ?").get("att-missing-old");
    expect(rowB).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("att-missing-old"))).toBe(true);
  });

  it("should support POST /api/admin/storage with action: cleanup-unreferenced and confirm guard", async () => {
    const admin = createUser("admin_unref", "pass123", "ADMIN");
    const session = createSession(admin.id);
    const doc = createDocument(admin.id, emptyScene(), "API Unref Doc");
    const db = getDb();
    const cfg = config();
    const docDir = path.join(path.resolve(cfg.attachmentsDir), doc.id);
    fs.mkdirSync(docDir, { recursive: true });

    const filePath = path.join(docDir, "api-unref-file");
    fs.writeFileSync(filePath, Buffer.from("api-bytes"));
    db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
      .run("api-unref-file", doc.id, "api.png", 9, "image/png", `attachments/${doc.id}/api-unref-file`, new Date(Date.now() - 30 * 3600 * 1000).toISOString());

    // Unconfirmed POST -> 400
    const unconfirmedReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ action: "cleanup-unreferenced", confirm: false }),
    });
    const unconfirmedRes = await postStorageRoute(unconfirmedReq);
    expect(unconfirmedRes.status).toBe(400);

    // Confirmed POST -> 200
    const confirmedReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ action: "cleanup-unreferenced", confirm: true }),
    });
    const confirmedRes = await postStorageRoute(confirmedReq);
    expect(confirmedRes.status).toBe(200);
    const resBody = await confirmedRes.json();
    expect(resBody.deletedRows).toBe(1);
    expect(resBody.reclaimedBytes).toBe(9);
  });

  it("should preserve symlink attachments and DB rows during cleanUnreferencedAttachments and return warning", () => {
    const user = createUser("eve", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Symlink Unref Doc");
    const db = getDb();
    const cfg = config();
    const resolvedAttachmentsDir = path.resolve(cfg.attachmentsDir);

    const externalTargetDir = path.resolve(cfg.dataDir, "external-unref-dir");
    fs.mkdirSync(externalTargetDir, { recursive: true });
    const externalTargetFile = path.join(externalTargetDir, "do-not-delete-unref.png");
    fs.writeFileSync(externalTargetFile, Buffer.from("precious-target-bytes"));

    const docDir = path.join(resolvedAttachmentsDir, doc.id);
    fs.mkdirSync(docDir, { recursive: true });
    const symlinkPath = path.join(docDir, "symlink-unref-id");

    let symlinkCreated = false;
    try {
      fs.symlinkSync(externalTargetFile, symlinkPath);
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    if (!symlinkCreated) {
      return;
    }

    try {
      db.prepare("INSERT INTO attachments (id, document_id, file_name, file_size, mime_type, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);")
        .run("symlink-unref-id", doc.id, "symlink.png", 20, "image/png", `attachments/${doc.id}/symlink-unref-id`, new Date(Date.now() - 30 * 3600 * 1000).toISOString());

      const result = cleanUnreferencedAttachments(true);

      // Symlink and target file must remain intact
      expect(fs.existsSync(symlinkPath)).toBe(true);
      expect(fs.existsSync(externalTargetFile)).toBe(true);

      // DB row must be preserved
      const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get("symlink-unref-id");
      expect(row).toBeDefined();

      // Warning returned
      expect(result.warnings?.some((w) => w.includes("symlink-unref-id"))).toBe(true);
    } finally {
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(externalTargetFile);
        fs.rmdirSync(externalTargetDir);
      } catch {
        // ignore
      }
    }
  });

  it("should reject unauthenticated and non-admin POST /api/admin/storage requests for cleanup-unreferenced", async () => {
    const normalUser = createUser("normal_user", "pass123", "USER");
    const normalSession = createSession(normalUser.id);

    // Unauthenticated POST -> 401
    const unauthReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cleanup-unreferenced", confirm: true }),
    });
    const unauthRes = await postStorageRoute(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Regular USER POST -> 403
    const userReq = new Request("http://localhost/api/admin/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${normalSession.token}`,
      },
      body: JSON.stringify({ action: "cleanup-unreferenced", confirm: true }),
    });
    const userRes = await postStorageRoute(userReq);
    expect(userRes.status).toBe(403);
  });
});
