import { describe, it, expect, beforeEach } from "vitest";
import { getDb, resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser } from "@/lib/users";
import { createDocument, getDocumentRaw, MAX_VERSIONS } from "@/lib/documents";
import {
  createSnapshotFromScene,
  listVersions,
  restoreVersion,
  msSinceLastSnapshot,
  snapshotDueForAutoSave,
  resolveRecoveryConflict,
} from "@/lib/versions";
import { emptyScene, jsonToScene, sceneToJson } from "@/lib/types";
import type { ExcalidrawScene } from "@/lib/types";

describe("Version History and Snapshots", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should create snapshots and list history with version numbers", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc 1");

    const sceneV1 = { ...emptyScene(), elements: [{ id: "1", type: "rectangle" }] };
    createSnapshotFromScene(doc.id, sceneV1, user.id, true);

    const sceneV2 = { ...emptyScene(), elements: [{ id: "2", type: "ellipse" }] };
    createSnapshotFromScene(doc.id, sceneV2, user.id, true);

    const versions = listVersions(doc.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].version_number).toBe(2);
    expect(versions[1].version_number).toBe(1);
    expect((versions[0] as any).created_by_username).toBe("alice");
  });

  it("should enforce auto-save throttling policy", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc 1");

    // No snapshot exists yet -> due immediately
    expect(snapshotDueForAutoSave(doc.id, 5 * 60 * 1000)).toBe(true);

    // After snapshot creation -> not due immediately
    createSnapshotFromScene(doc.id, emptyScene(), user.id, true);
    expect(msSinceLastSnapshot(doc.id)).toBeLessThan(1000);
    expect(snapshotDueForAutoSave(doc.id, 5 * 60 * 1000)).toBe(false);
  });

  it("should cap version history to MAX_VERSIONS (20)", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc 1");

    // Create 25 snapshots
    for (let i = 1; i <= 25; i++) {
      const scene = { ...emptyScene(), elements: [{ id: `elem-${i}`, type: "rectangle" }] };
      createSnapshotFromScene(doc.id, scene, user.id, false);
    }

    const versions = listVersions(doc.id);
    expect(versions.length).toBe(MAX_VERSIONS);
    // Oldest surviving version should be 6, newest is 25
    expect(versions[0].version_number).toBe(25);
    expect(versions[versions.length - 1].version_number).toBe(6);
  });

  it("should rollback / restore a past version and create a recovery snapshot", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc 1");

    const v1Scene = { ...emptyScene(), elements: [{ id: "v1-rect", type: "rectangle" }] };
    const snap1 = createSnapshotFromScene(doc.id, v1Scene, user.id, false);

    const v2Scene = { ...emptyScene(), elements: [{ id: "v2-ellipse", type: "ellipse" }] };
    createSnapshotFromScene(doc.id, v2Scene, user.id, false);

    // Restore back to v1
    restoreVersion(doc.id, snap1.id, user.id, "USER", false);

    // Document scene should now contain v1 elements
    const currentDoc = getDocumentRaw(doc.id)!;
    const restoredScene = jsonToScene(currentDoc.scene);
    expect(restoredScene.elements).toHaveLength(1);
    expect((restoredScene.elements[0] as any).id).toBe("v1-rect");

    // A new version snapshot (v3) should have been recorded for the restore
    const versions = listVersions(doc.id);
    expect(versions).toHaveLength(3);
    expect(versions[0].version_number).toBe(3);
  });

  it("snapshots the server scene before selecting the client scene", () => {
    const user = createUser("alice", "pass123", "USER");
    const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
    const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
    const doc = createDocument(user.id, serverScene, "Conflict Doc");

    const result = resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "client",
      preserveDiscarded: true,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene,
    });

    expect(result.ok).toBe(true);
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(clientScene.elements);
    const snapshot = getDb()
      .prepare("SELECT scene FROM document_versions WHERE document_id = ?")
      .get(doc.id) as { scene: string };
    expect(jsonToScene(snapshot.scene).elements).toEqual(serverScene.elements);
  });

  it("snapshots the client scene while keeping the server scene", () => {
    const user = createUser("alice", "pass123", "USER");
    const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
    const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
    const doc = createDocument(user.id, serverScene, "Conflict Doc");

    resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "server",
      preserveDiscarded: true,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene,
    });

    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(serverScene.elements);
    const snapshot = getDb()
      .prepare("SELECT scene FROM document_versions WHERE document_id = ?")
      .get(doc.id) as { scene: string };
    expect(jsonToScene(snapshot.scene).elements).toEqual(clientScene.elements);
  });

  it("creates no snapshot when preservation is disabled", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Conflict Doc");
    resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "server",
      preserveDiscarded: false,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene: {
        ...emptyScene(),
        elements: [{ id: "discarded", type: "image", fileId: "never-uploaded", isDeleted: false }],
        files: {
          "never-uploaded": {
            id: "never-uploaded",
            mimeType: "image/png",
            dataURL: "data:image/png;base64,QQ==",
            created: 1,
          },
        },
      },
    });
    expect(listVersions(doc.id)).toHaveLength(0);
  });

  it("updates to the client scene without a snapshot when preservation is disabled", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Conflict Doc");
    const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
    resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "client",
      preserveDiscarded: false,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene,
    });
    expect(listVersions(doc.id)).toHaveLength(0);
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(clientScene.elements);
  });

  it("returns the latest server scene without mutation when the version token changed", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Conflict Doc");
    const latest = { ...emptyScene(), elements: [{ id: "latest", type: "diamond" }] };
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(latest), "2099-01-01T00:00:00.000Z", doc.id);

    const result = resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "client",
      preserveDiscarded: true,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene: { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "SERVER_VERSION_CHANGED",
      serverUpdatedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(listVersions(doc.id)).toHaveLength(0);
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(latest.elements);
  });

  it("rolls back both snapshot and document update when the client scene is invalid", () => {
    const user = createUser("alice", "pass123", "USER");
    const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
    const doc = createDocument(user.id, serverScene, "Conflict Doc");
    const missingFileScene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "image", type: "image", fileId: "missing-file", isDeleted: false }],
      files: { "missing-file": { id: "missing-file", mimeType: "image/png", created: 1 } },
    };

    expect(() =>
      resolveRecoveryConflict(doc.id, user.id, "USER", false, {
        choice: "client",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: missingFileScene,
      }),
    ).toThrow(/attachment/i);
    expect(listVersions(doc.id)).toHaveLength(0);
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(serverScene.elements);
  });
});
