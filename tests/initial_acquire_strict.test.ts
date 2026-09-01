import { describe, it, expect } from "vitest";
import { InitialLeaseCoordinator } from "@/lib/client_edit_lease";
import type { LeaseResponse } from "@/lib/client_edit_lease";
import type { EditLeaseCredentials } from "@/lib/types";

describe("Initial acquire strict mode coordinator", () => {
  it("1. setup A -> cleanup A -> setup B -> resolve acquired: one acquire request, B finalizes once, zero release during replay", async () => {
    let acquireCount = 0;
    let resolveAcquire!: (res: LeaseResponse) => void;
    const acquireDeferred = new Promise<LeaseResponse>((resolve) => {
      resolveAcquire = resolve;
    });

    const releases: EditLeaseCredentials[] = [];
    const coordinator = new InitialLeaseCoordinator({
      docId: "doc-strict-1",
      clientId: "client-ctx-1",
      leaseToken: "token-strict-1",
      prior: null,
      acquireFn: async () => {
        acquireCount++;
        return acquireDeferred;
      },
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    let finalizedA = false;
    let finalizedB = false;
    let finalizedCredsB: EditLeaseCredentials | null = null;

    // Effect A setup
    const unsubA = coordinator.subscribe({
      onAcquired: async () => {
        finalizedA = true;
      },
      onHeld: () => {},
      onError: () => {},
    });

    expect(acquireCount).toBe(1);

    // Effect A cleanup (Strict Mode initial unmount)
    unsubA();
    expect(releases).toHaveLength(0);

    // Effect B setup (Strict Mode replay)
    const unsubB = coordinator.subscribe({
      onAcquired: async (creds) => {
        finalizedB = true;
        finalizedCredsB = creds;
      },
      onHeld: () => {},
      onError: () => {},
    });

    // Replay must reuse the existing flight; no second acquire request
    expect(acquireCount).toBe(1);
    expect(releases).toHaveLength(0);

    // Acquire request resolves
    resolveAcquire({
      state: "acquired",
      generation: 1,
      clientId: "client-ctx-1",
      leaseToken: "token-strict-1",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    });

    await acquireDeferred;
    await new Promise((r) => setTimeout(r, 0));

    expect(finalizedA).toBe(false);
    expect(finalizedB).toBe(true);
    expect(finalizedCredsB).toEqual({
      clientId: "client-ctx-1",
      leaseToken: "token-strict-1",
      generation: 1,
    });
    expect(releases).toHaveLength(0);

    unsubB();
  });

  it("2. setup -> genuine cleanup -> resolve acquired: release once, no finalize", async () => {
    let resolveAcquire!: (res: LeaseResponse) => void;
    const acquireDeferred = new Promise<LeaseResponse>((resolve) => {
      resolveAcquire = resolve;
    });

    const releases: EditLeaseCredentials[] = [];
    const coordinator = new InitialLeaseCoordinator({
      docId: "doc-strict-2",
      clientId: "client-ctx-2",
      leaseToken: "token-strict-2",
      prior: null,
      acquireFn: async () => acquireDeferred,
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    let finalized = false;
    const unsub = coordinator.subscribe({
      onAcquired: async () => {
        finalized = true;
      },
      onHeld: () => {},
      onError: () => {},
    });

    // Genuine unmount before server response
    unsub();
    expect(releases).toHaveLength(0);

    // Server responds with acquired after client has unmounted
    resolveAcquire({
      state: "acquired",
      generation: 1,
      clientId: "client-ctx-2",
      leaseToken: "token-strict-2",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    });

    await acquireDeferred;
    await new Promise((r) => setTimeout(r, 0));

    expect(finalized).toBe(false);
    expect(releases).toEqual([
      {
        clientId: "client-ctx-2",
        leaseToken: "token-strict-2",
        generation: 1,
      },
    ]);
  });

  it("3. finalized setup -> genuine cleanup: release once", async () => {
    const releases: EditLeaseCredentials[] = [];
    const coordinator = new InitialLeaseCoordinator({
      docId: "doc-strict-3",
      clientId: "client-ctx-3",
      leaseToken: "token-strict-3",
      prior: null,
      acquireFn: async () => ({
        state: "acquired",
        generation: 5,
        clientId: "client-ctx-3",
        leaseToken: "token-strict-3",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      }),
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    let finalized = false;
    const unsub = coordinator.subscribe({
      onAcquired: async () => {
        finalized = true;
      },
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(finalized).toBe(true);
    expect(releases).toHaveLength(0);

    // Genuine unmount of the finalized setup
    unsub();
    expect(releases).toEqual([
      {
        clientId: "client-ctx-3",
        leaseToken: "token-strict-3",
        generation: 5,
      },
    ]);
  });

  it("4. new docId: new flight/candidate, not old state", async () => {
    const releases: EditLeaseCredentials[] = [];
    let acquire1Count = 0;
    let acquire2Count = 0;

    const coordinator1 = new InitialLeaseCoordinator({
      docId: "doc-A",
      clientId: "client-ctx-1",
      leaseToken: "token-A",
      prior: null,
      acquireFn: async () => {
        acquire1Count++;
        return {
          state: "acquired",
          generation: 1,
          clientId: "client-ctx-1",
          leaseToken: "token-A",
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        };
      },
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    const coordinator2 = new InitialLeaseCoordinator({
      docId: "doc-B",
      clientId: "client-ctx-1",
      leaseToken: "token-B",
      prior: null,
      acquireFn: async () => {
        acquire2Count++;
        return {
          state: "acquired",
          generation: 1,
          clientId: "client-ctx-1",
          leaseToken: "token-B",
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        };
      },
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    expect(coordinator1.getDocId()).toBe("doc-A");
    expect(coordinator2.getDocId()).toBe("doc-B");

    coordinator1.subscribe({
      onAcquired: () => {},
      onHeld: () => {},
      onError: () => {},
    });

    coordinator2.subscribe({
      onAcquired: () => {},
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(acquire1Count).toBe(1);
    expect(acquire2Count).toBe(1);
    expect(coordinator1.getCandidate()?.leaseToken).toBe("token-A");
    expect(coordinator2.getCandidate()?.leaseToken).toBe("token-B");
  });
});