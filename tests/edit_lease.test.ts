import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb, getDb } from "@/lib/db";
import { addMember, createDocument } from "@/lib/documents";
import { createUser } from "@/lib/users";
import {
  acquireEditLease,
  heartbeatEditLease,
  requestEditTakeover,
  pollEditTakeover,
  releaseEditLease,
  assertActiveEditLease,
  LEASE_TTL_MS,
  TAKEOVER_TIMEOUT_MS,
} from "@/lib/edit_lease";
import { emptyScene } from "@/lib/types";

describe("Document edit lease state machine", () => {
  const NOW = new Date("2026-09-01T00:00:00.000Z");

  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  function makeDoc(ownerId: string) {
    return createDocument(ownerId, emptyScene(), "Doc");
  }

  function identity(docId: string, userId: string, overrides: Partial<{ clientId: string; leaseToken: string; priorLeaseToken: string; priorGeneration: number }> = {}) {
    return {
      docId,
      userId,
      role: "USER" as const,
      adminMode: false,
      clientId: overrides.clientId ?? "client-a",
      leaseToken: overrides.leaseToken ?? "token-a",
      ...(overrides.priorLeaseToken !== undefined ? { priorLeaseToken: overrides.priorLeaseToken } : {}),
      ...(overrides.priorGeneration !== undefined ? { priorGeneration: overrides.priorGeneration } : {}),
    };
  }

  it("acquires idempotently only for the same complete credentials", () => {
    const owner = createUser("owner", "pass123", "USER");
    const doc = makeDoc(owner.id);
    const first = acquireEditLease(identity(doc.id, owner.id, { leaseToken: "token-a" }), NOW);
    expect(first.state).toBe("acquired");
    if (first.state !== "acquired") throw new Error("expected acquired");
    const firstGen = first.generation;

    const retry = acquireEditLease(identity(doc.id, owner.id, { leaseToken: "token-a" }), NOW);
    expect(retry).toMatchObject({ state: "acquired", generation: firstGen });
    if (retry.state === "acquired") {
      expect(retry.generation).toBe(firstGen);
    }

    // Same-context re-entry: same per-context clientId, fresh page token, and exact prior
    // server-issued credentials as proof -> re-acquires immediately.
    const reacquired = acquireEditLease(identity(doc.id, owner.id, { leaseToken: "token-b", priorLeaseToken: "token-a", priorGeneration: firstGen }), NOW);
    expect(reacquired).toMatchObject({ state: "acquired" });
    if (reacquired.state === "acquired") {
      expect(reacquired.generation).toBe(firstGen + 1);
      expect(reacquired.clientId).toBe("client-a");
      expect(reacquired.leaseToken).toBe("token-b");
    }

    // A second context/screen of the same user (different clientId) is held even if it
    // has copied-storage credential data, because the holder's clientId no longer matches.
    const secondTab = acquireEditLease(identity(doc.id, owner.id, { clientId: "client-b", leaseToken: "token-c", priorLeaseToken: "token-b", priorGeneration: firstGen + 1 }), NOW);
    expect(secondTab).toMatchObject({ state: "held" });
    expect(JSON.stringify(secondTab)).not.toContain("token-b");
    expect(JSON.stringify(secondTab)).not.toContain("client-a");
    // holder summary should not leak tokens
    if (secondTab.state === "held") {
      expect(JSON.stringify(secondTab.holder)).not.toContain("token");
    }
  });

  it("advances generation and rejects the old holder after forced takeover", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = makeDoc(holder.id);
    // Grant requester write access
    addMember(doc.id, requester.id, "EDITOR");

    const holderInput = { docId: doc.id, userId: holder.id, role: "USER" as const, adminMode: false, clientId: "client-holder", leaseToken: "token-holder", generation: 0 };
    const requesterInput = { docId: doc.id, userId: requester.id, role: "USER" as const, adminMode: false, clientId: "client-requester", leaseToken: "token-requester" };

    const held = acquireEditLease({ docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-holder", leaseToken: "token-holder" }, NOW);
    expect(held.state).toBe("acquired");
    if (held.state !== "acquired") throw new Error("not acquired");
    const heldGen = held.generation;

    const pending = requestEditTakeover(requesterInput, NOW);
    expect(pending.state).toBe("takeover_pending");
    if (pending.state !== "takeover_pending") throw new Error("not pending");
    const requestId = pending.requestId;

    const acquired = pollEditTakeover(
      { ...requesterInput, requestId, generation: heldGen } as any,
      new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS),
    );
    expect(acquired.state).toBe("acquired");
    if (acquired.state !== "acquired") throw new Error("not acquired");
    expect(acquired.generation).toBe(heldGen + 1);

    // Old holder should be rejected
    expect(() =>
      assertActiveEditLease({ ...holderInput, generation: heldGen }, new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS)),
    ).toThrowError(/lost/i);

    // New holder should be valid
    expect(() =>
      assertActiveEditLease(
        { docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "client-requester", leaseToken: "token-requester", generation: acquired.generation },
        new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS),
      ),
    ).not.toThrow();
  });

  it("heartbeat renews expiry and signals pending takeover", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, requester.id, "EDITOR");

    const acquired = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (acquired.state !== "acquired") throw new Error("acquired");
    const gen = acquired.generation;

    // Heartbeat after 2 seconds
    const hb = heartbeatEditLease(
      { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen },
      new Date(NOW.getTime() + 2000),
    );
    expect(hb.state).toBe("acquired");

    // Request takeover
    const pending = requestEditTakeover(identity(doc.id, requester.id, { clientId: "client-b", leaseToken: "token-b" }), new Date(NOW.getTime() + 3000));
    expect(pending.state).toBe("takeover_pending");

    // Next heartbeat should signal pending
    const hb2 = heartbeatEditLease(
      { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen },
      new Date(NOW.getTime() + 4000),
    );
    expect(hb2.state).toBe("takeover_pending");
    if (hb2.state === "takeover_pending") {
      expect((hb2 as any).requestId).toBeDefined();
      expect(JSON.stringify(hb2)).not.toContain("token-b");
    }
  });

  it("allows direct acquisition of an expired row", () => {
    const holder = createUser("holder", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, other.id, "EDITOR");

    const first = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (first.state !== "acquired") throw new Error();
    const firstGen = first.generation;

    // Expire after 90s
    const expiredTime = new Date(NOW.getTime() + LEASE_TTL_MS + 1000);
    const second = acquireEditLease(identity(doc.id, other.id, { clientId: "client-b", leaseToken: "token-b" }), expiredTime);
    expect(second.state).toBe("acquired");
    if (second.state === "acquired") {
      expect(second.generation).toBe(firstGen + 1);
    }
  });

  it("graceful transfer on release advances generation", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, requester.id, "EDITOR");

    const held = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (held.state !== "acquired") throw new Error();
    const gen = held.generation;

    const pending = requestEditTakeover(identity(doc.id, requester.id, { clientId: "client-b", leaseToken: "token-b" }), NOW);
    expect(pending.state).toBe("takeover_pending");

    // Holder releases gracefully (acknowledges)
    const transferred = releaseEditLease(
      { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen },
      new Date(NOW.getTime() + 1000),
    );
    expect(transferred.state).toBe("transferred");
    expect(JSON.stringify(transferred)).not.toContain("token-b");
    expect(JSON.stringify(transferred)).not.toContain("client-b");
    // Verify generation advanced via DB and new holder installed
    const row = getDb().prepare("SELECT generation, holder_user_id, lease_token, holder_client_id FROM document_edit_leases WHERE document_id=?").get(doc.id) as any;
    expect(row.generation).toBe(gen + 1);
    expect(row.holder_user_id).toBe(requester.id);
    expect(row.lease_token).toBe("token-b");
    expect(row.holder_client_id).toBe("client-b");

    // Old holder rejected
    expect(() =>
      assertActiveEditLease({ docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen }, new Date(NOW.getTime() + 2000)),
    ).toThrowError(/lost/i);
  });

  it("release graceful transfer does not leak new holder credentials to old holder", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, requester.id, "EDITOR");
    const acquired = acquireEditLease(identity(doc.id, holder.id, { clientId: "c-holder", leaseToken: "t-holder-secret" }), NOW);
    if (acquired.state !== "acquired") throw new Error();
    const gen = acquired.generation;
    requestEditTakeover(identity(doc.id, requester.id, { clientId: "c-req", leaseToken: "t-req-secret" }), NOW);
    const result = releaseEditLease(
      { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "c-holder", leaseToken: "t-holder-secret", generation: gen },
      new Date(NOW.getTime() + 500),
    );
    expect(result.state).toBe("transferred");
    const json = JSON.stringify(result);
    expect(json).not.toContain("t-req-secret");
    expect(json).not.toContain("c-req");
    expect(json).not.toContain("leaseToken");
    expect(json).not.toContain("clientId");
  });

  it("VIEWER denial", () => {
    const owner = createUser("owner", "pass123", "USER");
    const viewer = createUser("viewer", "pass123", "USER");
    const doc = makeDoc(owner.id);
    addMember(doc.id, viewer.id, "VIEWER");

    expect(() => acquireEditLease(identity(doc.id, viewer.id), NOW)).toThrowError(/denied|read-only|access/i);
    // heartbeat also denied
    expect(() =>
      heartbeatEditLease({ docId: doc.id, userId: viewer.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: 1 }, NOW),
    ).toThrowError(/denied|read-only|access/i);
  });

  it("deleted-document denial", () => {
    const owner = createUser("owner", "pass123", "USER");
    const doc = makeDoc(owner.id);
    getDb().prepare("UPDATE documents SET deleted_at=? WHERE id=?").run(new Date().toISOString(), doc.id);
    expect(() => acquireEditLease(identity(doc.id, owner.id), NOW)).toThrowError(/not found/i);
  });

  it("first-pending-request wins", () => {
    const holder = createUser("holder", "pass123", "USER");
    const r1 = createUser("r1", "pass123", "USER");
    const r2 = createUser("r2", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, r1.id, "EDITOR");
    addMember(doc.id, r2.id, "EDITOR");

    acquireEditLease(identity(doc.id, holder.id), NOW);

    const p1 = requestEditTakeover(identity(doc.id, r1.id, { clientId: "c1", leaseToken: "t1" }), NOW);
    expect(p1.state).toBe("takeover_pending");

    const p2 = requestEditTakeover(identity(doc.id, r2.id, { clientId: "c2", leaseToken: "t2" }), new Date(NOW.getTime() + 100));
    expect(p2.state).toBe("takeover_in_progress");
    expect(JSON.stringify(p2)).not.toContain("t1");
  });

  it("idempotent retry by same request ID", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, requester.id, "EDITOR");

    acquireEditLease(identity(doc.id, holder.id), NOW);
    const reqId = "req-123";
    const first = requestEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", requestId: reqId }, NOW);
    expect(first.state).toBe("takeover_pending");
    if (first.state === "takeover_pending") expect(first.requestId).toBe(reqId);

    const second = requestEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c1", leaseToken: "t1", requestId: reqId }, new Date(NOW.getTime() + 100));
    expect(second.state).toBe("takeover_pending");
    if (second.state === "takeover_pending") expect(second.requestId).toBe(reqId);
  });

  it("holder summaries contain no tokens/client IDs", () => {
    const holder = createUser("holder", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, other.id, "EDITOR");

    acquireEditLease(identity(doc.id, holder.id, { clientId: "client-secret", leaseToken: "token-secret" }), NOW);
    const held = acquireEditLease(identity(doc.id, other.id, { clientId: "client-other", leaseToken: "token-other" }), NOW);
    expect(held.state).toBe("held");
    if (held.state === "held") {
      expect(held.holder.username).toBe("holder");
      expect(JSON.stringify(held.holder)).not.toContain("token-secret");
      expect(JSON.stringify(held.holder)).not.toContain("client-secret");
    }
  });

  it("heartbeat with stale generation throws EDIT_LEASE_LOST", () => {
    const holder = createUser("holder", "pass123", "USER");
    const doc = makeDoc(holder.id);
    const acquired = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (acquired.state !== "acquired") throw new Error();
    expect(() =>
      heartbeatEditLease(
        { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: acquired.generation + 1 },
        NOW,
      ),
    ).toThrowError(/lost/i);
  });

  it("ordinary release retains generation and allows reacquisition with incremented generation", () => {
    const holder = createUser("holder", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, other.id, "EDITOR");

    const first = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (first.state !== "acquired") throw new Error();
    const gen1 = first.generation;

    const releaseRes = releaseEditLease(
      { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen1 },
      new Date(NOW.getTime() + 1000),
    );
    // After release, row retained with generation gen1
    const rowAfter = getDb().prepare("SELECT generation, holder_user_id FROM document_edit_leases WHERE document_id=?").get(doc.id) as any;
    expect(rowAfter.generation).toBe(gen1);
    expect(rowAfter.holder_user_id).toBeNull();

    const second = acquireEditLease(identity(doc.id, other.id, { clientId: "client-b", leaseToken: "token-b" }), new Date(NOW.getTime() + 2000));
    expect(second.state).toBe("acquired");
    if (second.state === "acquired") expect(second.generation).toBe(gen1 + 1);
  });

  it("assertActiveEditLease throws on expired lease", () => {
    const holder = createUser("holder", "pass123", "USER");
    const doc = makeDoc(holder.id);
    const acquired = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (acquired.state !== "acquired") throw new Error();
    const gen = acquired.generation;
    const expired = new Date(NOW.getTime() + LEASE_TTL_MS + 5000);
    expect(() =>
      assertActiveEditLease(
        { docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen },
        expired,
      ),
    ).toThrowError(/lost/i);
  });

  it("deadline race: poll-first and release-first at deadline both transfer to requester", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    // poll-first scenario
    const doc1 = makeDoc(holder.id);
    addMember(doc1.id, requester.id, "EDITOR");
    const acq1 = acquireEditLease(identity(doc1.id, holder.id, { clientId: "c-h", leaseToken: "t-h" }), NOW);
    if (acq1.state !== "acquired") throw new Error();
    const gen1 = acq1.generation;
    const pend1 = requestEditTakeover(identity(doc1.id, requester.id, { clientId: "c-r", leaseToken: "t-r" }), NOW);
    if (pend1.state !== "takeover_pending") throw new Error();
    const requestId1 = (pend1 as any).requestId;
    const deadline1 = new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS);
    // Poll at deadline transfers
    const pollRes = pollEditTakeover({ docId: doc1.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-r", leaseToken: "t-r", requestId: requestId1 }, deadline1);
    expect(pollRes.state).toBe("acquired");
    if (pollRes.state === "acquired") expect(pollRes.generation).toBe(gen1 + 1);
    // Verify holder is requester
    const row1 = getDb().prepare("SELECT holder_user_id FROM document_edit_leases WHERE document_id=?").get(doc1.id) as any;
    expect(row1.holder_user_id).toBe(requester.id);

    // release-first scenario
    const doc2 = createDocument(holder.id, emptyScene(), "Doc2");
    addMember(doc2.id, requester.id, "EDITOR");
    const acq2 = acquireEditLease(identity(doc2.id, holder.id, { clientId: "c-h2", leaseToken: "t-h2" }), NOW);
    if (acq2.state !== "acquired") throw new Error();
    const gen2 = acq2.generation;
    const pend2 = requestEditTakeover(identity(doc2.id, requester.id, { clientId: "c-r2", leaseToken: "t-r2" }), NOW);
    if (pend2.state !== "takeover_pending") throw new Error();
    // Release at deadline should still transfer, not destroy pending
    const deadline2 = new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS);
    const relRes = releaseEditLease({ docId: doc2.id, userId: holder.id, role: "USER", adminMode: false, clientId: "c-h2", leaseToken: "t-h2", generation: gen2 }, deadline2);
    expect(relRes.state).toBe("transferred");
    const row2 = getDb().prepare("SELECT holder_user_id, generation FROM document_edit_leases WHERE document_id=?").get(doc2.id) as any;
    expect(row2.holder_user_id).toBe(requester.id);
    expect(row2.generation).toBe(gen2 + 1);
    // Poll after release should show requester already holder
    const pollAfter = pollEditTakeover({ docId: doc2.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-r2", leaseToken: "t-r2", requestId: (pend2 as any).requestId }, new Date(deadline2.getTime() + 100));
    expect(pollAfter.state).toBe("acquired");
  });

  it("stale holder release at deadline does not destroy structurally valid pending", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = makeDoc(holder.id);
    addMember(doc.id, requester.id, "EDITOR");
    const acq = acquireEditLease(identity(doc.id, holder.id), NOW);
    if (acq.state !== "acquired") throw new Error();
    const gen = acq.generation;
    const pend = requestEditTakeover(identity(doc.id, requester.id, { clientId: "c-r", leaseToken: "t-r" }), NOW);
    expect(pend.state).toBe("takeover_pending");
    const atDeadline = new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS);
    // Holder's release with correct credentials at deadline must transfer, not clear
    const res = releaseEditLease({ docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen }, atDeadline);
    expect(res.state).toBe("transferred");
    expect(JSON.stringify(res)).not.toContain("t-r");
  });
});
