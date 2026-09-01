import { describe, it, expect } from "vitest";
import { InitialLeaseCoordinator } from "@/lib/client_edit_lease";
import type { LeaseResponse } from "@/lib/client_edit_lease";
import type { EditLeaseCredentials } from "@/lib/types";

describe("Initial acquire strict mode coordinator", () => {
  it("1. setup A -> cleanup A while pending -> setup B -> resolve acquired: one acquire request, B finalizes once, zero release during replay", async () => {
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

  it("2. setup -> genuine cleanup while pending -> resolve acquired: release once, no finalize", async () => {
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

  it("4. late subscription after settled acquired result receives credentials without fresh request", async () => {
    let acquireCount = 0;
    const releases: EditLeaseCredentials[] = [];
    const coordinator = new InitialLeaseCoordinator({
      docId: "doc-late-1",
      clientId: "client-ctx-late",
      leaseToken: "token-late",
      prior: null,
      acquireFn: async () => {
        acquireCount++;
        return {
          state: "acquired",
          generation: 2,
          clientId: "client-ctx-late",
          leaseToken: "token-late",
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        };
      },
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    let firstAcquired = false;
    const unsub1 = coordinator.subscribe({
      onAcquired: () => {
        firstAcquired = true;
      },
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(firstAcquired).toBe(true);
    expect(acquireCount).toBe(1);

    // Late subscriber attaches while flight is already settled and active
    let lateAcquiredCreds: EditLeaseCredentials | null = null;
    const unsub2 = coordinator.subscribe({
      onAcquired: (creds) => {
        lateAcquiredCreds = creds;
      },
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(lateAcquiredCreds).toEqual({
      clientId: "client-ctx-late",
      leaseToken: "token-late",
      generation: 2,
    });
    expect(acquireCount).toBe(1);
    expect(releases).toHaveLength(0);

    unsub2();
    expect(releases).toEqual([
      {
        clientId: "client-ctx-late",
        leaseToken: "token-late",
        generation: 2,
      },
    ]);
    unsub1();
    // releaseOnce is idempotent
    expect(releases).toHaveLength(1);
  });

  it("5. held conflict and error delivery to subscribers without releasing", async () => {
    const releases: EditLeaseCredentials[] = [];
    let heldHolder: unknown = null;
    let heldPrior: unknown = null;

    const priorCreds = { leaseToken: "prior-t", generation: 1 };
    const coordinatorHeld = new InitialLeaseCoordinator({
      docId: "doc-held",
      clientId: "c-held",
      leaseToken: "t-held",
      prior: priorCreds,
      acquireFn: async () => ({
        state: "held",
        holder: { username: "other", acquiredAt: "now", heartbeatAt: "now" },
      }),
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    const unsubHeld = coordinatorHeld.subscribe({
      onAcquired: () => {},
      onHeld: (holder, prior) => {
        heldHolder = holder;
        heldPrior = prior;
      },
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(heldHolder).toEqual({ username: "other", acquiredAt: "now", heartbeatAt: "now" });
    expect(heldPrior).toEqual(priorCreds);

    unsubHeld();
    expect(releases).toHaveLength(0);

    // Test error delivery
    let deliveredError: unknown = null;
    const coordinatorErr = new InitialLeaseCoordinator({
      docId: "doc-err",
      clientId: "c-err",
      leaseToken: "t-err",
      prior: null,
      acquireFn: async () => {
        throw new Error("network disconnect");
      },
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    const unsubErr = coordinatorErr.subscribe({
      onAcquired: () => {},
      onHeld: () => {},
      onError: (err) => {
        deliveredError = err;
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect((deliveredError as Error)?.message).toBe("network disconnect");

    unsubErr();
    expect(releases).toHaveLength(0);
  });

  it("6. re-subscribe / new acquire after released lifecycle", async () => {
    let acquireCount = 0;
    const releases: EditLeaseCredentials[] = [];
    const coordinator = new InitialLeaseCoordinator({
      docId: "doc-resubscribe",
      clientId: "client-resub",
      leaseToken: () => `token-${acquireCount + 1}`,
      prior: null,
      acquireFn: async (_docId, candidate) => {
        acquireCount++;
        return {
          state: "acquired",
          generation: acquireCount,
          clientId: candidate.clientId,
          leaseToken: candidate.leaseToken,
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        };
      },
      releaseFn: (creds) => {
        releases.push(creds);
      },
    });

    // Lifecycle 1
    let creds1: EditLeaseCredentials | null = null;
    const unsub1 = coordinator.subscribe({
      onAcquired: (creds) => {
        creds1 = creds;
      },
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(acquireCount).toBe(1);
    expect(creds1).toEqual({ clientId: "client-resub", leaseToken: "token-1", generation: 1 });

    // Cleanup lifecycle 1 -> release occurs
    unsub1();
    expect(releases).toEqual([{ clientId: "client-resub", leaseToken: "token-1", generation: 1 }]);

    // Lifecycle 2: re-subscribe on the same coordinator starts a fresh acquire
    let creds2: EditLeaseCredentials | null = null;
    const unsub2 = coordinator.subscribe({
      onAcquired: (creds) => {
        creds2 = creds;
      },
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(acquireCount).toBe(2);
    expect(creds2).toEqual({ clientId: "client-resub", leaseToken: "token-2", generation: 2 });

    unsub2();
    expect(releases).toEqual([
      { clientId: "client-resub", leaseToken: "token-1", generation: 1 },
      { clientId: "client-resub", leaseToken: "token-2", generation: 2 },
    ]);
  });

  it("7. document transition in committed effect lifecycle releases old and acquires new without render side-effects", async () => {
    const releases: EditLeaseCredentials[] = [];
    const acquires: string[] = [];

    const makeCoordinator = (docId: string) =>
      new InitialLeaseCoordinator({
        docId,
        clientId: "client-nav",
        leaseToken: `token-${docId}`,
        prior: null,
        acquireFn: async (dId, cand) => {
          acquires.push(`${dId}:${cand.leaseToken}`);
          return {
            state: "acquired",
            generation: 1,
            clientId: cand.clientId,
            leaseToken: cand.leaseToken,
            acquiredAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          };
        },
        releaseFn: (creds) => {
          releases.push(creds);
        },
      });

    // Simulated React effect lifecycle for doc-1
    let coordinatorRef: InitialLeaseCoordinator | null = null;

    // Render 1 (Pure - no side effects)
    let currentDocId = "doc-1";

    // Committed Effect 1
    if (!coordinatorRef || coordinatorRef.getDocId() !== currentDocId) {
      coordinatorRef = makeCoordinator(currentDocId);
    }
    const unsubDoc1 = coordinatorRef.subscribe({
      onAcquired: () => {},
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(acquires).toEqual(["doc-1:token-doc-1"]);
    expect(releases).toHaveLength(0);

    // Render 2 with new docId (Pure - no side effects)
    currentDocId = "doc-2";
    expect(releases).toHaveLength(0);
    expect(acquires).toHaveLength(1);

    // Committed cleanup of Effect 1
    unsubDoc1();
    expect(releases).toEqual([{ clientId: "client-nav", leaseToken: "token-doc-1", generation: 1 }]);

    // Committed Effect 2
    if (!coordinatorRef || coordinatorRef.getDocId() !== currentDocId) {
      coordinatorRef = makeCoordinator(currentDocId);
    }
    const unsubDoc2 = coordinatorRef.subscribe({
      onAcquired: () => {},
      onHeld: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(acquires).toEqual(["doc-1:token-doc-1", "doc-2:token-doc-2"]);

    unsubDoc2();
    expect(releases).toEqual([
      { clientId: "client-nav", leaseToken: "token-doc-1", generation: 1 },
      { clientId: "client-nav", leaseToken: "token-doc-2", generation: 1 },
    ]);
  });
});