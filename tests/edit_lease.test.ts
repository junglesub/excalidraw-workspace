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

  function identity(docId: string, userId: string, overrides: Partial<{ clientId: string; leaseToken: string }> = {}) {
    return {
      docId,
      userId,
      role: "USER" as const,
      adminMode: false,
      clientId: overrides.clientId ?? "client-a",
      leaseToken: overrides.leaseToken ?? "token-a",
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

    const held = acquireEditLease(identity(doc.id, owner.id, { leaseToken: "token-b" }), NOW);
    expect(held).toMatchObject({ state: "held" });
    expect(JSON.stringify(held)).not.toContain("token-a");
    expect(JSON.stringify(held)).not.toContain("client-a");
    // holder summary should not leak tokens
    if (held.state === "held") {
      expect(JSON.stringify(held.holder)).not.toContain("token");
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
    expect(transferred.state).toBe("acquired");
    if (transferred.state === "acquired") {
      expect(transferred.generation).toBe(gen + 1);
      expect(transferred.clientId).toBe("client-b");
    }

    // Old holder rejected
    expect(() =>
      assertActiveEditLease({ docId: doc.id, userId: holder.id, role: "USER", adminMode: false, clientId: "client-a", leaseToken: "token-a", generation: gen }, new Date(NOW.getTime() + 2000)),
    ).toThrowError(/lost/i);
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
});
