import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createDocument, documentToMeta, getDocumentRaw } from "@/lib/documents";
import { createUser } from "@/lib/users";
import { acquireEditLease } from "@/lib/edit_lease";
import { emptyScene } from "@/lib/types";

describe("AdminMode writable editor entry", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("admin with adminMode true gets writable EDITOR meta and can acquire lease, while adminMode false yields VIEWER and blocked", () => {
    const owner = createUser("owner", "pass123", "USER");
    const admin = createUser("admin", "pass123", "ADMIN");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    const raw = getDocumentRaw(doc.id)!;

    const metaWithoutAdmin = documentToMeta(raw, admin.id, "ADMIN", false);
    expect(metaWithoutAdmin.permission).toBe("VIEWER");

    const metaWithAdmin = documentToMeta(raw, admin.id, "ADMIN", true);
    expect(metaWithAdmin.permission).toBe("EDITOR");
    expect(metaWithAdmin.permission).not.toBe("VIEWER");

    // Lease eligibility: without adminMode should be blocked (VIEWER)
    expect(() => acquireEditLease({ docId: doc.id, userId: admin.id, role: "ADMIN", adminMode: false, clientId: "c1", leaseToken: "t1" })).toThrow();

    // With adminMode true should acquire
    const res = acquireEditLease({ docId: doc.id, userId: admin.id, role: "ADMIN", adminMode: true, clientId: "c2", leaseToken: "t2" });
    expect(res.state).toBe("acquired");
  });

  it("non-admin with adminMode true remains VIEWER without lease", () => {
    const owner = createUser("owner", "pass123", "USER");
    const viewer = createUser("viewer", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    const raw = getDocumentRaw(doc.id)!;
    const meta = documentToMeta(raw, viewer.id, "USER", true);
    expect(meta.permission).toBe("VIEWER");
    expect(() => acquireEditLease({ docId: doc.id, userId: viewer.id, role: "USER", adminMode: true, clientId: "c1", leaseToken: "t1" })).toThrow();
  });
});
