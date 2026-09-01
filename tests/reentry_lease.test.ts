import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { addMember, createDocument } from "@/lib/documents";
import { createUser } from "@/lib/users";
import { acquireEditLease, heartbeatEditLease, releaseEditLease, requestEditTakeover, LEASE_TTL_MS, TAKEOVER_TIMEOUT_MS } from "@/lib/edit_lease";
import { emptyScene } from "@/lib/types";

describe("Re-entry lease false-conflict", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("same-context re-entry with exact prior credentials rotates and fences stale old operations", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const firstGen = (first as { generation: number }).generation;
    // Same browsing context reloads: same context id (clientId), fresh page token, and the
    // prior server-issued credentials (t1 + gen1) as proof -> immediate re-acquire/rotation.
    const second = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t2", priorLeaseToken: "t1", priorGeneration: firstGen }, new Date(now.getTime() + 1_000));
    expect(second.state).toBe("acquired");
    if (second.state === "acquired") {
      expect(second.generation).toBe(firstGen + 1);
      expect(second.clientId).toBe("c1");
      expect(second.leaseToken).toBe("t2");
    }
    // The previous page instance's stale-token heartbeat is fenced out.
    expect(() =>
      heartbeatEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", generation: firstGen }, new Date(now.getTime() + 2_000)),
    ).toThrowError(/lost/i);
    // A late best-effort pagehide release from the old page instance is fenced out and cannot clobber the new lease.
    expect(() =>
      releaseEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", generation: firstGen }, new Date(now.getTime() + 2_100)),
    ).toThrowError();
    const hb = heartbeatEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t2", generation: firstGen + 1 }, new Date(now.getTime() + 3_000));
    expect(hb.state).toBe("acquired");
  });

  it("copied-storage / new context cannot use prior credentials under a different context id", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const firstGen = (first as { generation: number }).generation;
    // An opener-created/duplicated context has its own window.name, so it gets a new context
    // id (c2). Even carrying the copied prior credentials (keyed under c1) it presents them
    // under c2, and the server requires holder_client_id === input.clientId -> held.
    const copied = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2", priorLeaseToken: "t1", priorGeneration: firstGen }, new Date(now.getTime() + 1_000));
    expect(copied.state).toBe("held");
    const beat = heartbeatEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", generation: firstGen }, new Date(now.getTime() + 2_000));
    expect(beat.state).toBe("acquired");
  });
it("same context id with stale prior token cannot rotate a live lease", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const firstGen = (first as { generation: number }).generation;
    // Same clientId but a wrong/stale prior token must not be accepted as re-entry proof.
    const badPrev = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t2", priorLeaseToken: "t-wrong", priorGeneration: firstGen }, new Date(now.getTime() + 1_000));
    expect(badPrev.state).toBe("held");
    const beat = heartbeatEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", generation: firstGen }, new Date(now.getTime() + 2_000));
    expect(beat.state).toBe("acquired");
  });

  it("normal second context (different clientId, no prior) remains held", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const second = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + 1_000));
    expect(second.state).toBe("held");
    // Original holder lease untouched: no steal, no generation advance.
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

  it("relaunched browser/new window (different clientId, stale heartbeat) recovers without takeover after the forced-takeover window", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    // A full browser close clears window.name; the new session generates a new context id and
    // has no matching prior credentials under it, so it stays held until the heartbeat is stale.
    const early = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + 1_000));
    expect(early.state).toBe("held");
    const recovered = acquireEditLease({ docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId: "c2", leaseToken: "t2" }, new Date(now.getTime() + TAKEOVER_TIMEOUT_MS + 1));
    expect(recovered.state).toBe("acquired");
  });

  it("same-context re-entry does not clobber a structurally valid pending takeover", () => {
    const owner = createUser("owner", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    addMember(doc.id, other.id, "EDITOR");
    const now = new Date();
    const first = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1" }, now);
    expect(first.state).toBe("acquired");
    const pending = requestEditTakeover({ docId: doc.id, userId: other.id, role: "USER", adminMode: false, clientId: "oc1", leaseToken: "ot1" }, new Date(now.getTime() + 11_000));
    expect(pending.state).toBe("takeover_pending");
    const second = acquireEditLease({ docId: doc.id, userId: owner.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t2", priorLeaseToken: "t1", priorGeneration: (first as { generation: number }).generation }, new Date(now.getTime() + 11_000));
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