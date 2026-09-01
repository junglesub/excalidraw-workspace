import { describe, it, expect, vi, beforeEach } from "vitest";
import { getLeaseClientId, acquireLease, heartbeatLease, requestTakeover, pollTakeover, releaseLease, canMutateCanvas, shouldReadLocalDraft, leaseHoldLockName, probeReentryLock, requestLeaseHold } from "@/lib/client_edit_lease";
import { ApiError } from "@/lib/client";
import { saveDocumentScene, resolveClientRecovery } from "@/lib/client_save";
import { emptyScene } from "@/lib/types";

describe("Client edit lease transport", () => {
  it("creates and reuses clientId via sessionStorage", () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem(k: string) { return store[k] ?? null; },
      setItem(k: string, v: string) { store[k] = v; },
    } as unknown as Storage;
    const first = getLeaseClientId(storage);
    expect(first).toMatch(/[0-9a-f-]{36}/i);
    const second = getLeaseClientId(storage);
    expect(second).toBe(first);
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

  it("sends the reentry attestation flag only when requested", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ state: "acquired", generation: 2, clientId: "c1", leaseToken: "t2", acquiredAt: "a", heartbeatAt: "b", expiresAt: "e" }), { status: 200 });
    });
    await acquireLease("doc1", { clientId: "c1", leaseToken: "t2" }, fetchMock as unknown as typeof fetch);
    expect(bodies[0].reentry).toBeUndefined();
    await acquireLease("doc1", { clientId: "c1", leaseToken: "t2" }, fetchMock as unknown as typeof fetch, undefined, { reentry: true });
    expect(bodies[1].reentry).toBe(true);
  });
});

describe("Web Locks per-context re-entry identity", () => {
  interface FakeLockManagerState {
    held: Set<string>;
    requests: Array<{ name: string; options: { ifAvailable?: boolean } }>;
  }

  function makeLockManager(state: FakeLockManagerState) {
    return {
      request: (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void>) => {
        state.requests.push({ name, options });
        const lock = state.held.has(name) ? null : { name, mode: "exclusive" };
        if (lock) state.held.add(name);
        return callback(lock).finally(() => {
          if (lock) state.held.delete(name);
        });
      },
    };
  }

  it("builds per-context lock names", () => {
    expect(leaseHoldLockName("doc1", "c1")).toBe("edit-lease-hold:doc1:c1");
  });

  it("probe returns true only when the per-context lock is free (previous context dead)", async () => {
    const state: FakeLockManagerState = { held: new Set(), requests: [] };
    const free = await probeReentryLock("doc1", "c1", { attempts: 2, delayMs: 1, locks: makeLockManager(state) });
    expect(free).toBe(true);
    expect(state.requests[0].name).toBe("edit-lease-hold:doc1:c1");
    expect(state.requests[0].options.ifAvailable).toBe(true);
  });

  it("probe returns false when a live context holds the lock (copied clientId collision)", async () => {
    const state: FakeLockManagerState = { held: new Set(["edit-lease-hold:doc1:c1"]), requests: [] };
    const busy = await probeReentryLock("doc1", "c1", { attempts: 3, delayMs: 1, locks: makeLockManager(state) });
    expect(busy).toBe(false);
    expect(state.requests.length).toBe(3);
  });

  it("probe is safe-fail when the Web Locks API is unavailable", async () => {
    const busy = await probeReentryLock("doc1", "c1", { locks: null });
    expect(busy).toBe(false);
  });

  it("requestLeaseHold holds the lock until released", async () => {
    const state: FakeLockManagerState = { held: new Set(), requests: [] };
    let releaseFn: (() => void) | null = null;
    requestLeaseHold("doc1", "c1", (release) => { releaseFn = release; }, makeLockManager(state));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.held.has("edit-lease-hold:doc1:c1")).toBe(true);
    (releaseFn as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.held.has("edit-lease-hold:doc1:c1")).toBe(false);
  });
});
