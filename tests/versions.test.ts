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
  handleManualSave,
  serializeForComparison,
} from "@/lib/versions";
import { emptyScene, jsonToScene, sceneToJson } from "@/lib/types";
import type { ExcalidrawScene } from "@/lib/types";
import { storeAttachment } from "@/lib/attachments";

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
    // Make v2 the current document state before restore
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(v2Scene), new Date().toISOString(), doc.id);

    // Restore back to v1
    restoreVersion(doc.id, snap1.id, user.id, "USER", false);

    // Document scene should now contain v1 elements
    const currentDoc = getDocumentRaw(doc.id)!;
    const restoredScene = jsonToScene(currentDoc.scene);
    expect(restoredScene.elements).toHaveLength(1);
    expect((restoredScene.elements[0] as any).id).toBe("v1-rect");

    // A new version snapshot (v3) should be of pre-restore v2, not v1, with origin restore
    const versions = listVersions(doc.id);
    expect(versions).toHaveLength(3);
    expect(versions[0].version_number).toBe(3);
    expect(versions[0].origin).toBe("restore");
    const snapV3 = getDb().prepare("SELECT scene FROM document_versions WHERE id = ?").get(versions[0].id) as { scene: string };
    expect(jsonToScene(snapV3.scene).elements[0] && (jsonToScene(snapV3.scene).elements[0] as any).id).toBe("v2-ellipse");
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

  it("manual save with same latest snapshot does not create snapshot and returns alreadySaved", () => {
    const user = createUser("alice", "pass123", "USER");
    const scene = { ...emptyScene(), elements: [{ id: "1", type: "rectangle" }] };
    const doc = createDocument(user.id, scene, "Doc");
    const first = handleManualSave(doc.id, user.id, "USER", false, scene, null);
    expect(first.alreadySaved).toBe(false);
    expect(first.snapshotCreated).toBe(true);
    expect(listVersions(doc.id)).toHaveLength(1);
    const latestId = listVersions(doc.id)[0].id;
    const updatedBefore = getDocumentRaw(doc.id)!.updated_at;
    const second = handleManualSave(doc.id, user.id, "USER", false, scene, null);
    expect(second.alreadySaved).toBe(true);
    expect(second.snapshotCreated).toBe(false);
    expect(listVersions(doc.id)).toHaveLength(1);
    expect(listVersions(doc.id)[0].id).toBe(latestId);
    expect(getDocumentRaw(doc.id)!.updated_at).toBe(updatedBefore);
  });

  it("manual save treats file insertion order and hydration dataURL as equal for alreadySaved", () => {
    const user = createUser("alice", "pass123", "USER");
    const base: ExcalidrawScene = {
      ...emptyScene(),
      elements: [
        { id: "a", type: "image", fileId: "f-a", isDeleted: false },
        { id: "b", type: "image", fileId: "f-b", isDeleted: false },
      ],
      files: {
        "f-a": { id: "f-a", mimeType: "image/png", created: 1 },
        "f-b": { id: "f-b", mimeType: "image/png", created: 2 },
      },
    };
    // Same normalized content but different file order and with dataURL (hydration) should be considered equal
    const reorderedWithDataURL: ExcalidrawScene = {
      ...base,
      files: {
        "f-b": { id: "f-b", mimeType: "image/png", created: 2, dataURL: "data:image/png;base64,QQ==" },
        "f-a": { id: "f-a", mimeType: "image/png", created: 1, dataURL: "data:image/png;base64,QQ==" },
      },
    };
    expect(serializeForComparison(base)).toBe(serializeForComparison(reorderedWithDataURL));

    // For handleManualSave, need actual attachments persisted, so create them
    const doc = createDocument(user.id, base, "Doc");
    // Ensure attachments exist for f-a and f-b (store dummy data)
    const dummy = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // minimal PNG header
    try {
      storeAttachment(doc.id, "f-a", "image/png", dummy, "f-a");
    } catch {}
    try {
      storeAttachment(doc.id, "f-b", "image/png", dummy, "f-b");
    } catch {}
    handleManualSave(doc.id, user.id, "USER", false, base, null);
    expect(listVersions(doc.id)).toHaveLength(1);
    // Reordered without dataURL but different file order should be considered equal for alreadySaved
    const reordered: ExcalidrawScene = {
      ...base,
      files: {
        "f-b": { id: "f-b", mimeType: "image/png", created: 2 },
        "f-a": { id: "f-a", mimeType: "image/png", created: 1 },
      },
    };
    expect(serializeForComparison(base)).toBe(serializeForComparison(reordered));
    const second = handleManualSave(doc.id, user.id, "USER", false, reordered, null);
    expect(second.alreadySaved).toBe(true);
    expect(second.snapshotCreated).toBe(false);
    expect(listVersions(doc.id)).toHaveLength(1);
  });

  it("manual save when saved but no snapshot creates one manual_save snapshot without document update", () => {
    const user = createUser("alice", "pass123", "USER");
    const scene = { ...emptyScene(), elements: [{ id: "1", type: "rectangle" }] };
    const doc = createDocument(user.id, scene, "Doc");
    expect(listVersions(doc.id)).toHaveLength(0);
    const beforeUpdated = getDocumentRaw(doc.id)!.updated_at;
    const result = handleManualSave(doc.id, user.id, "USER", false, scene, null);
    expect(result.alreadySaved).toBe(false);
    expect(result.snapshotCreated).toBe(true);
    expect(result.snapshot?.origin).toBe("manual_save");
    expect(listVersions(doc.id)).toHaveLength(1);
    expect(listVersions(doc.id)[0].origin).toBe("manual_save");
    // Document already saved, so updated_at should not change (no document update)
    expect(getDocumentRaw(doc.id)!.updated_at).toBe(beforeUpdated);
  });

  it("manual save when saved but latest differs creates snapshot without document update", () => {
    const user = createUser("alice", "pass123", "USER");
    const sceneA = { ...emptyScene(), elements: [{ id: "a", type: "rectangle" }] };
    const sceneB = { ...emptyScene(), elements: [{ id: "b", type: "ellipse" }] };
    const doc = createDocument(user.id, sceneA, "Doc");
    // Create initial snapshot with sceneA
    handleManualSave(doc.id, user.id, "USER", false, sceneA, null);
    expect(listVersions(doc.id)).toHaveLength(1);
    // Simulate document updated to sceneB via auto-save or direct (without manual snapshot)
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(sceneB), new Date().toISOString(), doc.id);
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(sceneB.elements);
    // Now latest snapshot is sceneA, current document is sceneB, incoming is sceneB (clean manual save)
    const beforeUpdated = getDocumentRaw(doc.id)!.updated_at;
    const result = handleManualSave(doc.id, user.id, "USER", false, sceneB, null);
    expect(result.alreadySaved).toBe(false);
    expect(result.snapshotCreated).toBe(true);
    expect(listVersions(doc.id)).toHaveLength(2);
    expect(listVersions(doc.id)[0].origin).toBe("manual_save");
    // Document already equals incoming, so no update
    expect(getDocumentRaw(doc.id)!.updated_at).toBe(beforeUpdated);
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(sceneB.elements);
  });

  it("dirty manual save creates snapshot and updates document", () => {
    const user = createUser("alice", "pass123", "USER");
    const sceneA = { ...emptyScene(), elements: [{ id: "a", type: "rectangle" }] };
    const sceneB = { ...emptyScene(), elements: [{ id: "a", type: "rectangle" }, { id: "b", type: "ellipse" }] };
    const doc = createDocument(user.id, sceneA, "Doc");
    handleManualSave(doc.id, user.id, "USER", false, sceneA, null);
    expect(listVersions(doc.id)).toHaveLength(1);
    const beforeUpdated = getDocumentRaw(doc.id)!.updated_at;
    // Dirty: incoming sceneB differs from current document sceneA
    const result = handleManualSave(doc.id, user.id, "USER", false, sceneB, null);
    expect(result.alreadySaved).toBe(false);
    expect(result.snapshotCreated).toBe(true);
    expect(listVersions(doc.id)).toHaveLength(2);
    expect(listVersions(doc.id)[0].origin).toBe("manual_save");
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(sceneB.elements);
    expect(getDocumentRaw(doc.id)!.updated_at).not.toBe(beforeUpdated);
  });

  it("manual save does not return alreadySaved when incoming matches latest but current differs - regression", () => {
    const user = createUser("alice", "pass123", "USER");
    const sceneA = { ...emptyScene(), elements: [{ id: "a", type: "rectangle" }] };
    const sceneB = { ...emptyScene(), elements: [{ id: "b", type: "ellipse" }] };
    const doc = createDocument(user.id, sceneA, "Doc");
    // First manual save creates snapshot with sceneA (latest = sceneA, current = sceneA)
    handleManualSave(doc.id, user.id, "USER", false, sceneA, null);
    expect(listVersions(doc.id)).toHaveLength(1);
    expect(serializeForComparison(jsonToScene(getDocumentRaw(doc.id)!.scene))).toBe(serializeForComparison(sceneA));
    // Simulate current document diverging to sceneB without a new snapshot (latest still sceneA, current is sceneB)
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(sceneB), new Date().toISOString(), doc.id);
    expect(serializeForComparison(jsonToScene(getDocumentRaw(doc.id)!.scene))).toBe(serializeForComparison(sceneB));
    const latestBefore = jsonToScene((getDb().prepare("SELECT scene FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1").get(doc.id) as { scene: string }).scene);
    expect(serializeForComparison(latestBefore)).toBe(serializeForComparison(sceneA));
    // Incoming matches old snapshot (sceneA) but current differs (sceneB) - must NOT be alreadySaved
    const beforeCount = listVersions(doc.id).length;
    const beforeUpdated = getDocumentRaw(doc.id)!.updated_at;
    const result = handleManualSave(doc.id, user.id, "USER", false, sceneA, null);
    expect(result.alreadySaved).toBe(false);
    expect(result.snapshotCreated).toBe(true);
    expect(listVersions(doc.id)).toHaveLength(beforeCount + 1);
    // Document should be updated to incoming (sceneA) because incoming differs from current
    expect(serializeForComparison(jsonToScene(getDocumentRaw(doc.id)!.scene))).toBe(serializeForComparison(sceneA));
    expect(getDocumentRaw(doc.id)!.updated_at).not.toBe(beforeUpdated);
    // Latest snapshot should now be sceneA as well
    const latestAfter = jsonToScene((getDb().prepare("SELECT scene FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1").get(doc.id) as { scene: string }).scene);
    expect(serializeForComparison(latestAfter)).toBe(serializeForComparison(sceneA));
  });
});
