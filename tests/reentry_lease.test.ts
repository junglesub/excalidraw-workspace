import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { addMember, createDocument } from "@/lib/documents";
import { createUser } from "@/lib/users";
import { acquireEditLease, heartbeatEditLease, requestEditTakeover, LEASE_TTL_MS } from "@/lib/edit_lease";
import { emptyScene } from "@/lib/types";

describe("Re-entry lease false-conflict", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("same user fresh acquire after close should not show held when no editor heartbeats", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    // Simulate close without pagehide release, then reopen after > TAKEOVER_TIMEOUT_MS
    // (lease still held in DB with stale heartbeat): re-entry must not be a false conflict.
    const second = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + 10_001));
    expect(second.state).toBe("acquired");
    if (second.state === "acquired") {
      expect(second.generation).toBe((first as { generation: number }).generation + 1);
      expect(second.clientId).toBe("c2");
      expect(second.leaseToken).toBe("t2");
    }
  });

  it("same user second live tab with fresh heartbeat still sees held (global one-editor lease)", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    // Second tab of the same user while the first is actively heartbeating: genuine conflict.
    const second = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + 1_000));
    expect(second.state).toBe("held");
    // And the original holder's lease must be untouched (no steal, no generation advance).
    const beat = heartbeatEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", generation: (first as { generation: number }).generation }, new Date(now.getTime() + 2_000));
    expect(beat.state).toBe("acquired");
  });

  it("different user still shows held when genuinely active", () => {
    const owner = createUser("owner", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    addMember(doc.id, other.id, "EDITOR");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const second = acquireEditLease({ docId: doc.id, userId: other.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + 1_000));
    expect(second.state).toBe("held");
  });

  it("same user stale re-entry does not clobber a pending takeover from another user", () => {
    const owner = createUser("owner", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    addMember(doc.id, other.id, "EDITOR");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const pending = requestEditTakeover({ docId: doc.id, userId: other.id, role: "USER", adminMode: false, clientId: "oc1", leaseToken: "ot1" }, new Date(now.getTime() + 11_000));
    expect(pending.state).toBe("takeover_pending");
    const second = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + 11_000));
    expect(second.state).toBe("held");
  });

  it("expired lease from prior session allows immediate acquire for anyone writable", () => {
    const owner = createUser("owner", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const second = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + LEASE_TTL_MS + 1));
    expect(second.state).toBe("acquired");
  });
});
