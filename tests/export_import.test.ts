import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, getDb } from "@/lib/db";
import { resetConfig, config } from "@/lib/config";
import { createUser, createSession } from "@/lib/users";
import { SESSION_COOKIE } from "@/lib/http";
import { createDocument, updateScene, getDocumentWithScene, getDocumentRaw } from "@/lib/documents";
import { createSnapshotFromScene } from "@/lib/versions";
import { permanentDelete } from "@/lib/trash";
import { migrateLegacyScenes } from "@/lib/init";
import {
  storeAttachment,
  listAttachments,
  readAttachmentBytes,
  deleteAttachmentIfUnreferenced,
  compactSceneFiles,
  hydrateSceneFiles,
  gcUnreferencedAttachments,
  attachUrl,
  getAttachment,
} from "@/lib/attachments";
import { GET as getAttachmentRoute } from "@/app/api/attachments/[attachmentId]/route";
import { jsonToScene, sceneToJson, emptyScene } from "@/lib/types";
import type { ExcalidrawScene } from "@/lib/types";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

describe("Attachments, Export/Import, and Compact/Hydrate Scene Pipeline", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should serialize and deserialize standard Excalidraw scene JSON", () => {
    const scene = {
      type: "excalidraw" as const,
      version: 2,
      source: "https://excalidraw.com",
      elements: [
        { id: "e1", type: "rectangle", x: 100, y: 100, width: 200, height: 150 },
        { id: "e2", type: "text", text: "Hello Excalidraw" },
      ],
      appState: { viewBackgroundColor: "#f0f0f0", theme: "light" },
      files: {},
    };

    const jsonStr = sceneToJson(scene);
    const parsed = jsonToScene(jsonStr);

    expect(parsed.type).toBe("excalidraw");
    expect(parsed.version).toBe(2);
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.appState?.viewBackgroundColor).toBe("#f0f0f0");
  });

  it("should handle empty or malformed scene JSON safely with fallback", () => {
    const fallback = jsonToScene("invalid-json-string");
    expect(fallback.type).toBe("excalidraw");
    expect(fallback.elements).toEqual([]);

    const empty = jsonToScene("{}");
    expect(empty.type).toBe("excalidraw");
    expect(empty.elements).toEqual([]);
  });

  it("should store and read file attachments correctly with JFIF support", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Design with Images");

    const sampleBuffer = Buffer.from("fake-jfif-image-content", "utf-8");
    const attachment = storeAttachment(doc.id, "photo.jfif", "image/jfif", sampleBuffer);

    expect(attachment.file_name).toBe("photo.jfif");
    expect(attachment.mime_type).toBe("image/jfif");
    expect(attachment.file_size).toBe(sampleBuffer.length);
    expect(attachment.sha256).toBeDefined();

    const storedBytes = readAttachmentBytes(attachment);
    expect(storedBytes.toString("utf-8")).toBe("fake-jfif-image-content");

    const attachments = listAttachments(doc.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe(attachment.id);
  });

  it("should compact scene by extracting dataURL to disk and hydrate it back on read", () => {
    const user = createUser("alice", "pass123", "USER");
    const fileId = "img_file_123";
    const rawImageBytes = Buffer.from("test-png-binary-data", "utf-8");
    const dataURL = `data:image/png;base64,${rawImageBytes.toString("base64")}`;

    const sceneWithImage: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [
        {
          id: "el-1",
          type: "image",
          fileId,
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          isDeleted: false,
        },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {
        [fileId]: {
          id: fileId,
          mimeType: "image/png",
          dataURL,
          created: 1720000000000,
        },
      },
    };

    // 1. Create document with image scene
    const doc = createDocument(user.id, sceneWithImage, "Image Test Doc");

    // Verify DB does NOT contain base64 dataURL
    const rawDoc = getDocumentRaw(doc.id)!;
    expect(rawDoc.scene.includes("data:image/")).toBe(false);
    expect(rawDoc.scene.includes(dataURL)).toBe(false);

    // Verify physical file was written to disk
    const diskPath = path.join(config().attachmentsDir, doc.id, fileId);
    expect(existsSync(diskPath)).toBe(true);
    expect(readFileSync(diskPath).toString("utf-8")).toBe("test-png-binary-data");

    // Verify attachments table record
    const atts = listAttachments(doc.id);
    expect(atts).toHaveLength(1);
    expect(atts[0].id).toBe(fileId);
    expect(atts[0].file_size).toBe(rawImageBytes.length);

    // 2. Read back via getDocumentWithScene (must hydrate dataURL)
    const { scene: hydrated } = getDocumentWithScene(doc.id, user.id, "USER", false);
    const files = hydrated.files as Record<string, { dataURL?: string }>;
    expect(files[fileId]).toBeDefined();
    expect(files[fileId].dataURL).toBe(dataURL);
  });

  it("should isolate cross-document attachments with same fileId and prevent cross-deletion", () => {
    const user = createUser("alice", "pass123", "USER");
    const sameFileId = "shared_file_id_1";

    const bytesA = Buffer.from("content-for-doc-a", "utf-8");
    const dataURL_A = `data:image/png;base64,${bytesA.toString("base64")}`;
    const sceneA: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: sameFileId, isDeleted: false }],
      appState: {},
      files: {
        [sameFileId]: { id: sameFileId, mimeType: "image/png", dataURL: dataURL_A },
      },
    };

    const bytesB = Buffer.from("different-content-for-doc-b", "utf-8");
    const dataURL_B = `data:image/png;base64,${bytesB.toString("base64")}`;
    const sceneB: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: sameFileId, isDeleted: false }],
      appState: {},
      files: {
        [sameFileId]: { id: sameFileId, mimeType: "image/png", dataURL: dataURL_B },
      },
    };

    const docA = createDocument(user.id, sceneA, "Doc A");
    const docB = createDocument(user.id, sceneB, "Doc B");

    const pathA = path.join(config().attachmentsDir, docA.id, sameFileId);
    const pathB = path.join(config().attachmentsDir, docB.id, sameFileId);

    // Both files exist separately
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    expect(readFileSync(pathA).toString("utf-8")).toBe("content-for-doc-a");
    expect(readFileSync(pathB).toString("utf-8")).toBe("different-content-for-doc-b");

    // Both hydrate to their respective content
    const { scene: hydratedA } = getDocumentWithScene(docA.id, user.id, "USER", false);
    const { scene: hydratedB } = getDocumentWithScene(docB.id, user.id, "USER", false);
    expect((hydratedA.files as Record<string, { dataURL?: string }>)[sameFileId].dataURL).toBe(dataURL_A);
    expect((hydratedB.files as Record<string, { dataURL?: string }>)[sameFileId].dataURL).toBe(dataURL_B);

    // Permanently delete Doc A
    permanentDelete(docA.id, user.id, "USER");

    // Doc A's attachment is deleted, but Doc B's attachment is completely unaffected
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(true);
    expect(readFileSync(pathB).toString("utf-8")).toBe("different-content-for-doc-b");

    const { scene: hydratedBAfter } = getDocumentWithScene(docB.id, user.id, "USER", false);
    expect((hydratedBAfter.files as Record<string, { dataURL?: string }>)[sameFileId].dataURL).toBe(dataURL_B);
  });

  it("should disambiguate GET /api/attachments/[attachmentId] using docId query parameter", async () => {
    const user = createUser("alice", "pass123", "USER");
    const sameFileId = "multi_doc_attachment_1";

    const bytesA = Buffer.from("bytes-A", "utf-8");
    const sceneA: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: sameFileId, isDeleted: false }],
      appState: {},
      files: {
        [sameFileId]: { id: sameFileId, mimeType: "image/png", dataURL: `data:image/png;base64,${bytesA.toString("base64")}` },
      },
    };

    const bytesB = Buffer.from("bytes-B", "utf-8");
    const sceneB: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: sameFileId, isDeleted: false }],
      appState: {},
      files: {
        [sameFileId]: { id: sameFileId, mimeType: "image/png", dataURL: `data:image/png;base64,${bytesB.toString("base64")}` },
      },
    };

    const docA = createDocument(user.id, sceneA, "Doc A");
    const docB = createDocument(user.id, sceneB, "Doc B");

    // Create session for user
    const session = createSession(user.id);

    // Query with docId=docA.id
    const reqA = new Request(`http://localhost/api/attachments/${sameFileId}?docId=${docA.id}`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    const resA = await getAttachmentRoute(reqA, { params: { attachmentId: sameFileId } });
    expect(resA.status).toBe(200);
    const bodyA = Buffer.from(await resA.arrayBuffer());
    expect(bodyA.toString("utf-8")).toBe("bytes-A");

    // Query with docId=docB.id
    const reqB = new Request(`http://localhost/api/attachments/${sameFileId}?docId=${docB.id}`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    const resB = await getAttachmentRoute(reqB, { params: { attachmentId: sameFileId } });
    expect(resB.status).toBe(200);
    const bodyB = Buffer.from(await resB.arrayBuffer());
    expect(bodyB.toString("utf-8")).toBe("bytes-B");
  });

  it("should successfully run startup legacy scene migration", () => {
    const user = createUser("alice", "pass123", "USER");
    const rawBytes = Buffer.from("legacy-image-content", "utf-8");
    const dataURL = `data:image/png;base64,${rawBytes.toString("base64")}`;
    const fileId = "legacy_file_99";

    const uncompactedScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId, isDeleted: false }],
      appState: {},
      files: {
        [fileId]: { id: fileId, mimeType: "image/png", dataURL },
      },
    };

    // Insert legacy document directly with inline Base64
    const docId = "legacy_doc_1";
    const db = getDb();
    db.prepare(
      `INSERT INTO documents (id, title, owner_id, scene, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(docId, "Legacy Doc", user.id, JSON.stringify(uncompactedScene), new Date().toISOString(), new Date().toISOString());

    // Run migration
    const res = migrateLegacyScenes();
    expect(res.migratedDocs).toBe(1);
    expect(res.errors).toHaveLength(0);

    // Verify DB scene is now compacted (no base64)
    const docRaw = getDocumentRaw(docId)!;
    expect(docRaw.scene.includes("data:image/")).toBe(false);

    // Verify file exists on disk
    const diskPath = path.join(config().attachmentsDir, docId, fileId);
    expect(existsSync(diskPath)).toBe(true);

    // Verify getDocumentWithScene hydrates correctly
    const { scene: hydrated } = getDocumentWithScene(docId, user.id, "USER", false);
    expect((hydrated.files as Record<string, { dataURL?: string }>)[fileId].dataURL).toBe(dataURL);
  });

  it("should clean up all newly created files on disk if persistence fails (no orphaned files)", () => {
    const user = createUser("alice", "pass123", "USER");
    const rawBytes = Buffer.from("temp-image", "utf-8");
    const dataURL = `data:image/png;base64,${rawBytes.toString("base64")}`;

    // Scene with 1 valid image and 1 invalid image that will throw an error
    const sceneWithBadMime: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "e1", type: "image", fileId: "file_valid", isDeleted: false },
        { id: "e2", type: "image", fileId: "file_invalid", isDeleted: false },
      ],
      appState: {},
      files: {
        file_valid: { id: "file_valid", mimeType: "image/png", dataURL },
        file_invalid: { id: "file_invalid", mimeType: "application/pdf", dataURL: "data:application/pdf;base64,AAAA" },
      },
    };

    expect(() => createDocument(user.id, sceneWithBadMime, "Failed Doc")).toThrow();

    // Check attachments dir: no orphaned files should remain
    const attDir = config().attachmentsDir;
    if (existsSync(attDir)) {
      const entries = readdirSync(attDir);
      for (const entry of entries) {
        const full = path.join(attDir, entry);
        if (existsSync(full)) {
          const files = readdirSync(full);
          expect(files).not.toContain("file_valid");
        }
      }
    }
  });

  it("should atomically restore a missing disk file for an existing row and roll back on error", () => {
    const user = createUser("alice", "pass123", "USER");
    const fileId = "recovered_file_1";
    const rawBytes = Buffer.from("recovered-bytes", "utf-8");
    const dataURL = `data:image/png;base64,${rawBytes.toString("base64")}`;

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId, isDeleted: false }],
      appState: {},
      files: {
        [fileId]: { id: fileId, mimeType: "image/png", dataURL },
      },
    };

    const doc = createDocument(user.id, scene, "Recovery Doc");
    const diskPath = path.join(config().attachmentsDir, doc.id, fileId);
    expect(existsSync(diskPath)).toBe(true);

    // Simulate accidental disk file loss
    unlinkSync(diskPath);
    expect(existsSync(diskPath)).toBe(false);

    // 1. Updating with the valid scene recovers the missing file on disk
    updateScene(doc.id, scene, user.id, "USER");
    expect(existsSync(diskPath)).toBe(true);

    // 2. Now delete it again, but this time pass another corrupted file to trigger rollback
    unlinkSync(diskPath);
    expect(existsSync(diskPath)).toBe(false);

    const corruptScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "e1", type: "image", fileId, isDeleted: false },
        { id: "e2", type: "image", fileId: "bad_mime", isDeleted: false },
      ],
      appState: {},
      files: {
        [fileId]: { id: fileId, mimeType: "image/png", dataURL },
        bad_mime: { id: "bad_mime", mimeType: "invalid/mime", dataURL: "data:invalid/mime;base64,AAAA" },
      },
    };

    expect(() => updateScene(doc.id, corruptScene, user.id, "USER")).toThrow();
    // Since updateScene failed, recovered file must be safely rolled back
    expect(existsSync(diskPath)).toBe(false);
  });

  it("should perform GC when older snapshots referencing the image are pruned beyond MAX_VERSIONS", () => {
    const user = createUser("alice", "pass123", "USER");
    const fileId = "img_prune_test";
    const rawImageBytes = Buffer.from("prune-image-data", "utf-8");
    const dataURL = `data:image/png;base64,${rawImageBytes.toString("base64")}`;

    const sceneWithImage: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "el-1", type: "image", fileId, isDeleted: false }],
      appState: {},
      files: {
        [fileId]: { id: fileId, mimeType: "image/png", dataURL },
      },
    };

    const doc = createDocument(user.id, sceneWithImage, "Prune GC Doc");
    // Create 1 snapshot containing the image
    createSnapshotFromScene(doc.id, sceneWithImage, user.id, false);

    const diskPath = path.join(config().attachmentsDir, doc.id, fileId);
    expect(existsSync(diskPath)).toBe(true);

    // Update active scene to no longer use the image
    const cleanScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: false }],
      appState: {},
      files: {},
    };
    updateScene(doc.id, cleanScene, user.id, "USER");

    // File still exists on disk because snapshot 1 references it
    expect(existsSync(diskPath)).toBe(true);

    // Now generate 20 new snapshots with cleanScene, exceeding MAX_VERSIONS (20)
    for (let i = 0; i < 20; i++) {
      createSnapshotFromScene(doc.id, cleanScene, user.id, false);
    }

    // Now snapshot 1 has been trimmed away, and GC has deleted the unreferenced attachment file
    expect(existsSync(diskPath)).toBe(false);
    expect(listAttachments(doc.id)).toHaveLength(0);
  });

  it("should strictly reject invalid fileId, empty Base64, invalid Base64 syntax, and path traversal", () => {
    const user = createUser("alice", "pass123", "USER");

    // 1. Path traversal in fileId
    const badIdScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: "../malicious", isDeleted: false }],
      appState: {},
      files: {
        "../malicious": { id: "../malicious", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" },
      },
    };
    expect(() => createDocument(user.id, badIdScene, "Bad ID")).toThrow();

    // 2. Empty Base64 payload
    const emptyBase64Scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: "empty_file", isDeleted: false }],
      appState: {},
      files: {
        empty_file: { id: "empty_file", mimeType: "image/png", dataURL: "data:image/png;base64," },
      },
    };
    expect(() => createDocument(user.id, emptyBase64Scene, "Empty Base64")).toThrow();

    // 3. Invalid Base64 syntax (non-base64 characters / invalid length)
    const invalidSyntaxScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: "syntax_file", isDeleted: false }],
      appState: {},
      files: {
        syntax_file: { id: "syntax_file", mimeType: "image/png", dataURL: "data:image/png;base64,%%%INVALID%%%" },
      },
    };
    expect(() => createDocument(user.id, invalidSyntaxScene, "Invalid Base64 Syntax")).toThrow();

    // 4. Corrupted dataURL prefix
    const corruptPrefixScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "e1", type: "image", fileId: "corrupt_file", isDeleted: false }],
      appState: {},
      files: {
        corrupt_file: { id: "corrupt_file", mimeType: "image/png", dataURL: "data:image/png;notbase64,AAAA" },
      },
    };
    expect(() => createDocument(user.id, corruptPrefixScene, "Corrupt Prefix")).toThrow();
  });

  it("should have experimental.instrumentationHook enabled in next.config and executable register hook", async () => {
    const nextConfigModule = await import("../next.config.mjs");
    const nextConfig = nextConfigModule.default;
    expect(nextConfig.experimental?.instrumentationHook).toBe(true);

    const prevRuntime = process.env.NEXT_RUNTIME;
    try {
      process.env.NEXT_RUNTIME = "nodejs";
      const { register } = await import("@/instrumentation");
      await expect(register()).resolves.not.toThrow();
    } finally {
      process.env.NEXT_RUNTIME = prevRuntime;
    }
  });
});
