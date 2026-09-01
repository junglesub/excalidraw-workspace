import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireLease, heartbeatLease, requestTakeover, pollTakeover, releaseLease, canMutateCanvas, shouldReadLocalDraft, getEditorContextId, parseEditorContextId, leaseCredentialsKey, readStoredLeaseCredentials, storeLeaseCredentials, clearStoredLeaseCredentials } from "@/lib/client_edit_lease";
import { ApiError } from "@/lib/client";
import { saveDocumentScene, resolveClientRecovery } from "@/lib/client_save";
import { emptyScene } from "@/lib/types";

describe("Client edit lease transport", () => {
function withMockWindow(name: string, fn: () => void): void {
    const g = globalThis as { window?: { name: string } };
    const original = g.window;
    g.window = { name };
    try {
      fn();
    } finally {
      g.window = original;
    }
  }

  it("gets a per-browsing-context id from window.name and reuses it across instances", () => {
    let firstId = "";
    withMockWindow("", () => { firstId = getEditorContextId(); });
    expect(firstId).toMatch(/[0-9a-f-]{36}/i);
    // A reload in the same browsing context finds the same window.name -> same id.
    withMockWindow("ecid:" + firstId, () => {
      expect(getEditorContextId()).toBe(firstId);
    });
  });

  it("a new editor context (empty window.name) generates a different id", () => {
    let id1 = "";
    let id2 = "";
    withMockWindow("", () => { id1 = getEditorContextId(); });
    withMockWindow("", () => { id2 = getEditorContextId(); });
    expect(id1).not.toBe(id2);
  });

  it("parses only editor-prefixed valid ids", () => {
    const id = crypto.randomUUID();
    expect(parseEditorContextId("ecid:" + id)).toBe(id);
    expect(parseEditorContextId("other:" + id)).toBeNull();
    expect(parseEditorContextId("ecid:not-a-uuid")).toBeNull();
    expect(parseEditorContextId("")).toBeNull();
  });


  it("parses ApiError with status and code", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "lost", code: "EDIT_LEASE_LOST" }), { status: 409 }));
    await expect(acquireLease("doc1", { clientId: "c1", leaseToken: "t1" }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({ status: 409, code: "EDIT_LEASE_LOST" });
    try {
      await acquireLease("doc1", { clientId: "c1", leaseToken: "t1" }, fetchMock as unknown as typeof fetch);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
      expect((e as ApiError).code).toBe("EDIT_LEASE_LOST");
    }
  });

  it("sends credentials in every lease action", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ body });
      return new Response(JSON.stringify({ state: "acquired", generation: 1 }), { status: 200 });
    });

    await acquireLease("doc1", { clientId: "c1", leaseToken: "t1" }, fetchMock as unknown as typeof fetch);
    expect(calls[0].body).toMatchObject({ action: "acquire", clientId: "c1", leaseToken: "t1" });

    await heartbeatLease("doc1", { clientId: "c1", leaseToken: "t1", generation: 3 }, fetchMock as unknown as typeof fetch);
    expect(calls[1].body).toMatchObject({ action: "heartbeat", clientId: "c1", leaseToken: "t1", generation: 3 });

    await requestTakeover("doc1", { clientId: "c2", leaseToken: "t2" }, fetchMock as unknown as typeof fetch);
    expect(calls[2].body).toMatchObject({ action: "request_takeover", clientId: "c2", leaseToken: "t2" });

    await pollTakeover("doc1", { clientId: "c2", leaseToken: "t2", requestId: "req-1" }, fetchMock as unknown as typeof fetch);
    expect(calls[3].body).toMatchObject({ action: "poll_takeover", clientId: "c2", leaseToken: "t2", requestId: "req-1" });

    await releaseLease("doc1", { clientId: "c1", leaseToken: "t1", generation: 3 }, fetchMock as unknown as typeof fetch);
    expect(calls[4].body).toMatchObject({ action: "release", clientId: "c1", leaseToken: "t1", generation: 3 });
  });

  it("includes lease credentials in scene/manual/recovery payloads", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (String(url).includes("/scene") || String(url).includes("/save")) {
        expect(body).toMatchObject({ lease: { clientId: "client-a", leaseToken: "token-a", generation: 3 } });
        return new Response(JSON.stringify({ ok: true, snapshotCreated: false, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url).includes("/recovery")) {
        expect(body).toMatchObject({ lease: { clientId: "client-a", leaseToken: "token-a", generation: 3 } });
        return new Response(JSON.stringify({ ok: true, choice: "client", snapshotCreated: false, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url).includes("/attachments")) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await saveDocumentScene({
      docId: "doc1",
      scene: emptyScene(),
      persistedFileIds: new Set(),
      isManualSave: false,
      snapshotDue: false,
      lease: { clientId: "client-a", leaseToken: "token-a", generation: 3 },
      fetchFn: fetchMock,
    });

    await saveDocumentScene({
      docId: "doc1",
      scene: emptyScene(),
      persistedFileIds: new Set(),
      isManualSave: true,
      lease: { clientId: "client-a", leaseToken: "token-a", generation: 3 },
      fetchFn: fetchMock,
    });

    await resolveClientRecovery({
      docId: "doc1",
      choice: "client",
      preserveDiscarded: false,
      expectedServerUpdatedAt: new Date().toISOString(),
      draft: { scene: emptyScene(), updatedAt: 123 },
      persistedFileIds: new Set(),
      lease: { clientId: "client-a", leaseToken: "token-a", generation: 3 },
      fetchFn: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalled();
  });

  it("pure transition helpers", () => {
    expect(canMutateCanvas("active")).toBe(true);
    expect(canMutateCanvas("handoff")).toBe(false);
    expect(canMutateCanvas("blocked")).toBe(false);
    expect(canMutateCanvas("viewer")).toBe(false);
    expect(canMutateCanvas("readonly")).toBe(false);
    expect(canMutateCanvas("lost")).toBe(false);
    expect(shouldReadLocalDraft("active")).toBe(true);
    expect(shouldReadLocalDraft("viewer")).toBe(false);
    expect(shouldReadLocalDraft("blocked")).toBe(false);
    expect(shouldReadLocalDraft("readonly")).toBe(false);
    expect(shouldReadLocalDraft("handoff")).toBe(false);
    expect(shouldReadLocalDraft("lost")).toBe(false);
  });

  it("returns held state without throwing for 409 held", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: "held", holder: { username: "bob", acquiredAt: "a", heartbeatAt: "b" }, code: "EDIT_LEASE_HELD" }), { status: 409 }));
    const result = await acquireLease("doc1", { clientId: "c2", leaseToken: "t2" }, fetchMock as unknown as typeof fetch);
    expect(result.state).toBe("held");
    expect((result as { holder: { username: string } }).holder.username).toBe("bob");
  });

  it("sends prior lease credentials as re-entry proof when provided", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ state: "acquired", generation: 2, clientId: "c1", leaseToken: "t2", acquiredAt: "a", heartbeatAt: "b", expiresAt: "e" }), { status: 200 });
    });
    await acquireLease("doc1", { clientId: "c1", leaseToken: "t2" }, fetchMock as unknown as typeof fetch);
    expect(bodies[0].priorLeaseToken).toBeUndefined();
    expect(bodies[0].priorGeneration).toBeUndefined();
    await acquireLease("doc1", { clientId: "c1", leaseToken: "t2", priorLeaseToken: "t1", priorGeneration: 1 }, fetchMock as unknown as typeof fetch);
    expect(bodies[1].priorLeaseToken).toBe("t1");
    expect(bodies[1].priorGeneration).toBe(1);
  });
});
describe("Per-context identity and stored credential helpers", () => {
  function makeStorage(initial: Record<string, string> = {}): Storage {
    const store: Record<string, string> = { ...initial };
    return {
      getItem(k: string) { return store[k] ?? null; },
      setItem(k: string, v: string) { store[k] = v; },
      removeItem(k: string) { delete store[k]; },
    } as unknown as Storage;
  }

  it("keys stored lease credentials by document and context id", () => {
    expect(leaseCredentialsKey("doc1", "c1")).toBe("excalidraw_lease_cred:doc1:c1");
    expect(leaseCredentialsKey("doc1", "c1")).not.toBe(leaseCredentialsKey("doc1", "c2"));
    expect(leaseCredentialsKey("doc1", "c1")).not.toBe(leaseCredentialsKey("doc2", "c1"));
  });

  it("stores and reads back server-issued lease credentials under the owning context", () => {
    const storage = makeStorage();
    storeLeaseCredentials(storage, "doc1", "c1", { leaseToken: "t1", generation: 3 });
    expect(readStoredLeaseCredentials(storage, "doc1", "c1")).toEqual({ leaseToken: "t1", generation: 3 });
    // A different context id or document cannot read them back (keyed by context).
    expect(readStoredLeaseCredentials(storage, "doc1", "c2")).toBeNull();
    expect(readStoredLeaseCredentials(storage, "doc2", "c1")).toBeNull();
  });

  it("rejects malformed stored credentials and clears cleanly", () => {
    const malformed: Record<string, string> = {
      "excalidraw_lease_cred:doc1:c1": JSON.stringify({ leaseToken: "", generation: 0 }),
      "excalidraw_lease_cred:doc1:c2": "not-json",
    };
    const storage = makeStorage(malformed);
    expect(readStoredLeaseCredentials(storage, "doc1", "c1")).toBeNull();
    expect(readStoredLeaseCredentials(storage, "doc1", "c2")).toBeNull();
    storeLeaseCredentials(storage, "doc1", "c1", { leaseToken: "t1", generation: 1 });
    clearStoredLeaseCredentials(storage, "doc1", "c1");
    expect(readStoredLeaseCredentials(storage, "doc1", "c1")).toBeNull();
  });
});
