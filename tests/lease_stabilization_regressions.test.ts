import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createDocument } from "@/lib/documents";
import { createUser } from "@/lib/users";
import { acquireEditLease, pollEditTakeover, LEASE_TTL_MS } from "@/lib/edit_lease";
import { emptyScene } from "@/lib/types";

describe("Stabilization regressions - should fail before fix", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("pollEditTakeover should NOT return acquired for expired holder", () => {
    const holder = createUser("holder", "pass123", "USER");
    const doc = createDocument(holder.id, emptyScene(), "Doc");
    const now = new Date();
    const acquired = acquireEditLease({ docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    if (acquired.state !== "acquired") throw new Error("acquire failed");
    const expiredTime = new Date(now.getTime() + LEASE_TTL_MS + 1000);
    expect(() => pollEditTakeover({ docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", requestId: "req1" }, expiredTime)).toThrowError(/lost/i);
  });

  it("adminMode true should allow admin to acquire without membership", () => {
    const owner = createUser("owner", "pass123", "USER");
    const admin = createUser("admin", "pass123", "ADMIN");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    const now = new Date();
    // Admin without membership, with adminMode false should fail
    expect(() => acquireEditLease({ docId: doc.id, userId: admin.id, role: "ADMIN", adminMode: false, clientId: "c1", leaseToken: "t1" }, now)).toThrow();
    // With adminMode true should succeed
    const res = acquireEditLease({ docId: doc.id, userId: admin.id, role: "ADMIN", adminMode: true, clientId: "c1", leaseToken: "t1" }, now);
    expect(res.state).toBe("acquired");
  });
});
