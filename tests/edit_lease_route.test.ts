import { beforeEach, describe, expect, it } from "vitest";
import { POST as leaseRoute } from "@/app/api/documents/[id]/lease/route";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { addMember, createDocument } from "@/lib/documents";
import { SESSION_COOKIE } from "@/lib/http";
import { createSession, createUser } from "@/lib/users";
import { emptyScene } from "@/lib/types";

describe("Lease API route", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  function request(docId: string, token: string | undefined, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["cookie"] = `${SESSION_COOKIE}=${token}`;
    return new Request(`http://localhost/api/documents/${docId}/lease`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("acquires and returns held conflict without token leakage", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    addMember(doc.id, other.id, "EDITOR");
    const sessOwner = createSession(owner.id);
    const sessOther = createSession(other.id);

    const acquireResponse = await leaseRoute(request(doc.id, sessOwner.token, { action: "acquire", clientId: "c1", leaseToken: "t1" }), { params: Promise.resolve({ id: doc.id }) });
    expect(acquireResponse.status).toBe(200);
    expect((await acquireResponse.json()).state).toBe("acquired");

    const heldResponse = await leaseRoute(request(doc.id, sessOther.token, { action: "acquire", clientId: "c2", leaseToken: "t2" }), { params: Promise.resolve({ id: doc.id }) });
    expect(heldResponse.status).toBe(409);
    const heldBody = await heldResponse.json();
    expect(heldBody).toMatchObject({ code: "EDIT_LEASE_HELD" });
    expect(JSON.stringify(heldBody)).not.toContain("t1");
    expect(JSON.stringify(heldBody)).not.toContain("leaseToken");
    expect(heldBody.holder.username).toBe("owner");
  });

  it("handles all five actions and malformed fields", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const other = createUser("other", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    addMember(doc.id, other.id, "EDITOR");
    const sessOwner = createSession(owner.id);
    const sessOther = createSession(other.id);

    // acquire
    const acq = await leaseRoute(request(doc.id, sessOwner.token, { action: "acquire", clientId: "c1", leaseToken: "tok1" }), { params: Promise.resolve({ id: doc.id }) });
    const acqBody = await acq.json();
    expect(acqBody.state).toBe("acquired");
    const gen = acqBody.generation;

    // heartbeat
    const hb = await leaseRoute(request(doc.id, sessOwner.token, { action: "heartbeat", clientId: "c1", leaseToken: "tok1", generation: gen }), { params: Promise.resolve({ id: doc.id }) });
    expect(hb.status).toBe(200);
    expect((await hb.json()).state).toBe("acquired");

    // request_takeover
    const reqTake = await leaseRoute(request(doc.id, sessOther.token, { action: "request_takeover", clientId: "c2", leaseToken: "tok2" }), { params: Promise.resolve({ id: doc.id }) });
    expect(reqTake.status).toBe(200);
    const reqBody = await reqTake.json();
    expect(reqBody.state).toBe("takeover_pending");
    const requestId = reqBody.requestId;

    // poll_takeover before deadline should still be pending
    const pollPending = await leaseRoute(request(doc.id, sessOther.token, { action: "poll_takeover", clientId: "c2", leaseToken: "tok2", requestId }), { params: Promise.resolve({ id: doc.id }) });
    expect(pollPending.status).toBe(200);
    expect((await pollPending.json()).state).toBe("takeover_pending");

    // release gracefully transfers to pending requester
    const rel = await leaseRoute(request(doc.id, sessOwner.token, { action: "release", clientId: "c1", leaseToken: "tok1", generation: gen }), { params: Promise.resolve({ id: doc.id }) });
    expect(rel.status).toBe(200);
    const relBody = await rel.json();
    expect(relBody.state).toBe("acquired");
    expect(relBody.generation).toBe(gen + 1);

    // malformed/missing action fields 400
    const bad = await leaseRoute(request(doc.id, sessOwner.token, { action: "acquire", clientId: "", leaseToken: "tok" }), { params: Promise.resolve({ id: doc.id }) });
    expect(bad.status).toBe(400);
    const bad2 = await leaseRoute(request(doc.id, sessOwner.token, { action: "heartbeat", clientId: "c1", leaseToken: "tok1" }), { params: Promise.resolve({ id: doc.id }) });
    expect(bad2.status).toBe(400);
    const bad3 = await leaseRoute(request(doc.id, sessOwner.token, { bad: "field" }), { params: Promise.resolve({ id: doc.id }) });
    expect(bad3.status).toBe(400);
  });

  it("returns 401 for unauthenticated, 403 for VIEWER, 409 lost for stale credentials", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const viewer = createUser("viewer", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Doc");
    addMember(doc.id, viewer.id, "VIEWER");
    const sessViewer = createSession(viewer.id);
    const sessOwner = createSession(owner.id);

    const unauth = await leaseRoute(request(doc.id, undefined, { action: "acquire", clientId: "c1", leaseToken: "t1" }), { params: Promise.resolve({ id: doc.id }) });
    expect(unauth.status).toBe(401);

    const viewerResp = await leaseRoute(request(doc.id, sessViewer.token, { action: "acquire", clientId: "c1", leaseToken: "t1" }), { params: Promise.resolve({ id: doc.id }) });
    expect(viewerResp.status).toBe(403);

    // Acquire correctly then heartbeat with wrong generation => lost
    const acq = await leaseRoute(request(doc.id, sessOwner.token, { action: "acquire", clientId: "c1", leaseToken: "t1" }), { params: Promise.resolve({ id: doc.id }) });
    const body = await acq.json();
    const hbLost = await leaseRoute(request(doc.id, sessOwner.token, { action: "heartbeat", clientId: "c1", leaseToken: "t1", generation: body.generation + 99 }), { params: Promise.resolve({ id: doc.id }) });
    expect(hbLost.status).toBe(409);
    const hbLostBody = await hbLost.json();
    expect(hbLostBody.code).toBe("EDIT_LEASE_LOST");
    expect(JSON.stringify(hbLostBody)).not.toContain("t1");
  });

  it("enforces first-request-wins takeover via TAKEOVER_IN_PROGRESS", async () => {
    const holder = createUser("holder", "pass123", "USER");
    const r1 = createUser("r1", "pass123", "USER");
    const r2 = createUser("r2", "pass123", "USER");
    const doc = createDocument(holder.id, emptyScene(), "Doc");
    addMember(doc.id, r1.id, "EDITOR");
    addMember(doc.id, r2.id, "EDITOR");
    const sHolder = createSession(holder.id);
    const sR1 = createSession(r1.id);
    const sR2 = createSession(r2.id);

    await leaseRoute(request(doc.id, sHolder.token, { action: "acquire", clientId: "cH", leaseToken: "tH" }), { params: Promise.resolve({ id: doc.id }) });
    const p1 = await leaseRoute(request(doc.id, sR1.token, { action: "request_takeover", clientId: "c1", leaseToken: "t1" }), { params: Promise.resolve({ id: doc.id }) });
    expect(p1.status).toBe(200);
    const p2 = await leaseRoute(request(doc.id, sR2.token, { action: "request_takeover", clientId: "c2", leaseToken: "t2" }), { params: Promise.resolve({ id: doc.id }) });
    expect(p2.status).toBe(409);
    const b2 = await p2.json();
    expect(b2.code).toBe("TAKEOVER_IN_PROGRESS");
    expect(JSON.stringify(b2)).not.toContain("t1");
  });
});
