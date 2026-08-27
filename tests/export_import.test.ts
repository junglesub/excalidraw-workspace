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
import { GET as getExportRoute } from "@/app/api/documents/[id]/export/route";
import { POST as postAttachmentRoute } from "@/app/api/documents/[id]/attachments/route";
import { POST as postSaveRoute } from "@/app/api/documents/[id]/save/route";
import { PUT as putSceneRoute } from "@/app/api/documents/[id]/scene/route";
import { jsonToScene, sceneToJson, emptyScene } from "@/lib/types";
import type { ExcalidrawScene } from "@/lib/types";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { renderScenePng } from "@/lib/thumbnails";

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

    // 2. Read back via getDocumentWithScene with hydrate: true (must hydrate dataURL)
    const { scene: hydrated } = getDocumentWithScene(doc.id, user.id, "USER", false, { hydrate: true });
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

    // Both hydrate to their respective content with hydrate: true
    const { scene: hydratedA } = getDocumentWithScene(docA.id, user.id, "USER", false, { hydrate: true });
    const { scene: hydratedB } = getDocumentWithScene(docB.id, user.id, "USER", false, { hydrate: true });
    expect((hydratedA.files as Record<string, { dataURL?: string }>)[sameFileId].dataURL).toBe(dataURL_A);
    expect((hydratedB.files as Record<string, { dataURL?: string }>)[sameFileId].dataURL).toBe(dataURL_B);

    // Permanently delete Doc A
    permanentDelete(docA.id, user.id, "USER");

    // Doc A's attachment is deleted, but Doc B's attachment is completely unaffected
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(true);
    expect(readFileSync(pathB).toString("utf-8")).toBe("different-content-for-doc-b");

    const { scene: hydratedBAfter } = getDocumentWithScene(docB.id, user.id, "USER", false, { hydrate: true });
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
    const resA = await getAttachmentRoute(reqA, { params: Promise.resolve({ attachmentId: sameFileId }) });
    expect(resA.status).toBe(200);
    const bodyA = Buffer.from(await resA.arrayBuffer());
    expect(bodyA.toString("utf-8")).toBe("bytes-A");

    // Query with docId=docB.id
    const reqB = new Request(`http://localhost/api/attachments/${sameFileId}?docId=${docB.id}`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    const resB = await getAttachmentRoute(reqB, { params: Promise.resolve({ attachmentId: sameFileId }) });
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

    // Verify getDocumentWithScene with hydrate: true hydrates correctly
    const { scene: hydrated } = getDocumentWithScene(docId, user.id, "USER", false, { hydrate: true });
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

    // 1. Updating with the valid scene recovers the missing file on disk (with allowInlineDataUrl: true)
    updateScene(doc.id, scene, user.id, "USER", false, { allowInlineDataUrl: true });
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

    expect(() => updateScene(doc.id, corruptScene, user.id, "USER", false, { allowInlineDataUrl: true })).toThrow();
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
    // Create 1 snapshot containing the image (from compact doc scene)
    createSnapshotFromScene(doc.id, jsonToScene(doc.scene), user.id, false);

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

  it("should have serverExternalPackages configured in next.config and executable register hook", async () => {
    const nextConfigModule = await import("../next.config.mjs");
    const nextConfig = nextConfigModule.default;
    expect(nextConfig.serverExternalPackages).toContain("node:sqlite");

    const prevRuntime = process.env.NEXT_RUNTIME;
    try {
      process.env.NEXT_RUNTIME = "nodejs";
      const { register } = await import("@/instrumentation");
      await expect(register()).resolves.not.toThrow();
    } finally {
      process.env.NEXT_RUNTIME = prevRuntime;
    }
  });

  it("should return fully hydrated standalone scene with dataURL on GET /api/documents/[id]/export", async () => {
    const user = createUser("alice", "pass123", "USER");
    const fileId = "export_img_1";
    const rawBytes = Buffer.from("export-image-content", "utf-8");
    const dataURL = `data:image/png;base64,${rawBytes.toString("base64")}`;
    const scene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "e1", type: "image", fileId, isDeleted: false }],
      files: {
        [fileId]: { id: fileId, mimeType: "image/png", dataURL, created: Date.now() },
      },
    };
    const doc = createDocument(user.id, scene, "Export Doc");

    const session = createSession(user.id);
    const req = new Request(`http://localhost/api/documents/${doc.id}/export`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    const res = await getExportRoute(req, { params: Promise.resolve({ id: doc.id }) });
    expect(res.status).toBe(200);
    const content = await res.text();
    const parsed = JSON.parse(content);
    expect(parsed.files[fileId]).toBeDefined();
    expect(parsed.files[fileId].dataURL).toBe(dataURL);
  });

  it("should handle deterministic fileId uploads: 201 on new, 200 idempotent on match, 409 on conflict, UUID fallback", async () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Upload Doc");
    const session = createSession(user.id);

    const rawBytes = Buffer.from("test-binary-png-data", "utf-8");
    const customFileId = "custom_file_123";

    // 1. Upload new attachment with deterministic fileId -> 201 Created
    const form1 = new FormData();
    form1.append("file", new File([rawBytes], "image.png", { type: "image/png" }));
    form1.append("fileId", customFileId);

    const req1 = new Request(`http://localhost/api/documents/${doc.id}/attachments`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
      body: form1,
    });
    const res1 = await postAttachmentRoute(req1, { params: Promise.resolve({ id: doc.id }) });
    expect(res1.status).toBe(201);
    const body1 = await res1.json();
    expect(body1.attachment.id).toBe(customFileId);

    // 2. Same fileId + same bytes -> 200 OK (idempotent no-op)
    const form2 = new FormData();
    form2.append("file", new File([rawBytes], "image.png", { type: "image/png" }));
    form2.append("fileId", customFileId);

    const req2 = new Request(`http://localhost/api/documents/${doc.id}/attachments`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
      body: form2,
    });
    const res2 = await postAttachmentRoute(req2, { params: Promise.resolve({ id: doc.id }) });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.attachment.id).toBe(customFileId);

    // 3. Same fileId + different bytes -> 409 Conflict
    const differentBytes = Buffer.from("completely-different-content", "utf-8");
    const form3 = new FormData();
    form3.append("file", new File([differentBytes], "image.png", { type: "image/png" }));
    form3.append("fileId", customFileId);

    const req3 = new Request(`http://localhost/api/documents/${doc.id}/attachments`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
      body: form3,
    });
    const res3 = await postAttachmentRoute(req3, { params: Promise.resolve({ id: doc.id }) });
    expect(res3.status).toBe(409);

    // 4. Upload with omitted fileId -> 201 with server generated UUID
    const form4 = new FormData();
    form4.append("file", new File([rawBytes], "generic.png", { type: "image/png" }));

    const req4 = new Request(`http://localhost/api/documents/${doc.id}/attachments`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
      body: form4,
    });
    const res4 = await postAttachmentRoute(req4, { params: Promise.resolve({ id: doc.id }) });
    expect(res4.status).toBe(201);
    const body4 = await res4.json();
    expect(body4.attachment.id).toBeDefined();
    expect(body4.attachment.id).not.toBe(customFileId);

    // 5. Invalid fileId format -> 400 Bad Request
    const form5 = new FormData();
    form5.append("file", new File([rawBytes], "image.png", { type: "image/png" }));
    form5.append("fileId", "../path_traversal");

    const req5 = new Request(`http://localhost/api/documents/${doc.id}/attachments`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
      body: form5,
    });
    const res5 = await postAttachmentRoute(req5, { params: Promise.resolve({ id: doc.id }) });
    expect(res5.status).toBe(400);
  });

  it("should reject inline dataURL on steady-state /save and /scene routes with 400 Bad Request", async () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Save Reject Doc");
    const session = createSession(user.id);

    const dirtyScene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "e1", type: "image", fileId: "file_1", isDeleted: false }],
      files: {
        file_1: {
          id: "file_1",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,aGVsbG8=",
          created: Date.now(),
        },
      },
    };

    // 1. POST /api/documents/[id]/save must reject inline dataURL
    const saveReq = new Request(`http://localhost/api/documents/${doc.id}/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ scene: dirtyScene }),
    });
    const saveRes = await postSaveRoute(saveReq, { params: Promise.resolve({ id: doc.id }) });
    expect(saveRes.status).toBe(400);

    // 2. PUT /api/documents/[id]/scene must reject inline dataURL
    const sceneReq = new Request(`http://localhost/api/documents/${doc.id}/scene`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ scene: dirtyScene }),
    });
    const sceneRes = await putSceneRoute(sceneReq, { params: Promise.resolve({ id: doc.id }) });
    expect(sceneRes.status).toBe(400);
  });

  it("should persist a client-captured PNG thumbnail on manual save instead of the placeholder fallback", async () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Client Thumb Doc");
    const session = createSession(user.id);

    const clientPng = renderScenePng(emptyScene(), 64, 36);
    const thumbnailBase64 = `data:image/png;base64,${clientPng.toString("base64")}`;
    const placeholder = renderScenePng(emptyScene(), 320, 180);

    const saveReq = new Request(`http://localhost/api/documents/${doc.id}/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({
        scene: { ...emptyScene(), elements: [{ id: "rect-1", type: "rectangle" }] },
        thumbnailBase64,
      }),
    });
    const saveRes = await postSaveRoute(saveReq, { params: Promise.resolve({ id: doc.id }) });
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    const thumbAbs = path.join(config().dataDir, saveBody.snapshot.thumbnail_path);
    const savedBytes = readFileSync(thumbAbs);
    expect(savedBytes.equals(clientPng)).toBe(true);
    expect(savedBytes.equals(placeholder)).toBe(false);
  });

  it("should generate server thumbnail and persist snapshot on manual save without thumbnailBase64", async () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Thumbnail Save Doc");
    const session = createSession(user.id);

    const cleanScene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "rect-1", type: "rectangle", x: 10, y: 10, width: 100, height: 100 }],
    };

    const saveReq = new Request(`http://localhost/api/documents/${doc.id}/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify({ scene: cleanScene }), // thumbnailBase64 completely omitted
    });
    const saveRes = await postSaveRoute(saveReq, { params: Promise.resolve({ id: doc.id }) });
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody.ok).toBe(true);
    expect(saveBody.snapshot).toBeDefined();
    expect(saveBody.snapshot.thumbnail_path).toBeDefined();

    // Verify thumbnail exists physically on disk
    const thumbAbs = path.join(config().dataDir, saveBody.snapshot.thumbnail_path);
    expect(existsSync(thumbAbs)).toBe(true);
    expect(readFileSync(thumbAbs).length).toBeGreaterThan(0);
  });
});
