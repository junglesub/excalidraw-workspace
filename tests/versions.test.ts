import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser } from "@/lib/users";
import { createDocument, getDocumentRaw, MAX_VERSIONS } from "@/lib/documents";
import {
  createSnapshotFromScene,
  listVersions,
  restoreVersion,
  msSinceLastSnapshot,
  snapshotDueForAutoSave,
} from "@/lib/versions";
import { emptyScene, jsonToScene } from "@/lib/types";

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
});
