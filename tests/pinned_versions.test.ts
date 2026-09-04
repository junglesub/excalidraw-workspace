import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createUser } from "@/lib/users";
import { createDocument } from "@/lib/documents";
import { emptyScene } from "@/lib/types";
import {
  createPinnedSnapshotFromDoc,
  createSnapshotFromDoc,
  getVersion,
  listVersions,
} from "@/lib/versions";

describe("pinned document versions", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("keeps pinned snapshots outside ordinary version retention", () => {
    const user = createUser("pinned-owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Pinned");
    const pinned = createPinnedSnapshotFromDoc(doc.id, user.id, "named_snapshot");

    for (let i = 0; i < 25; i += 1) {
      createSnapshotFromDoc(doc.id, user.id, false, null, { origin: "manual_save" });
    }

    expect(getVersion(pinned.id)?.is_pinned).toBe(1);
    const versions = listVersions(doc.id);
    expect(versions.filter((version) => version.is_pinned === 0)).toHaveLength(20);
    expect(versions.some((version) => version.id === pinned.id)).toBe(true);
  });
});
