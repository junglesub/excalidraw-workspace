import { describe, it, expect, vi, afterEach } from "vitest";
import { credentialKey, dispatchRelease } from "@/lib/client_edit_lease";
import type { EditLeaseCredentials } from "@/lib/types";

describe("Credential-keyed release guard - production-connected", () => {
  it("coalesces same credential but releases separate late-cancelled credential", () => {
    const released = new Set<string>();
    const releaseOnce = (creds: EditLeaseCredentials) => {
      const key = credentialKey(creds);
      if (released.has(key)) return false;
      released.add(key);
      return true;
    };

    const credA: EditLeaseCredentials = { clientId: "c1", leaseToken: "t1", generation: 1 };
    const credA_dup: EditLeaseCredentials = { clientId: "c1", leaseToken: "t1", generation: 1 };
    const credB: EditLeaseCredentials = { clientId: "c1", leaseToken: "t2", generation: 2 };

    expect(credentialKey(credA)).toBe(credentialKey(credA_dup));
    expect(credentialKey(credA)).not.toBe(credentialKey(credB));

    expect(releaseOnce(credA)).toBe(true);
    expect(releaseOnce(credA_dup)).toBe(false); // same credential coalesced
    expect(releaseOnce(credB)).toBe(true); // different credential still releases even after previous
    expect(released.size).toBe(2);
  });

  it("is collision-free for delimiters permitted in validated input", () => {
    const a: EditLeaseCredentials = { clientId: "a:b", leaseToken: "c", generation: 1 };
    const b: EditLeaseCredentials = { clientId: "a", leaseToken: "b:c", generation: 1 };
    expect(credentialKey(a)).not.toBe(credentialKey(b));
    const c: EditLeaseCredentials = { clientId: "a:b:c", leaseToken: "d:e", generation: 1 };
    const d: EditLeaseCredentials = { clientId: "a:b", leaseToken: "c:d:e", generation: 1 };
    expect(credentialKey(c)).not.toBe(credentialKey(d));
  });

  it("rejected beacon falls back to keepalive fetch and only then records released", () => {
    const released = new Set<string>();
    const creds: EditLeaseCredentials = { clientId: "c1", leaseToken: "t1", generation: 1 };
    const key = credentialKey(creds);
    let beaconCalls = 0;
    let fetchCalls = 0;
    const beaconMock = () => { beaconCalls++; return false; };
    const fetchMock = () => { fetchCalls++; return Promise.resolve(new Response(null, { status: 200 })); };
    const url = "http://localhost/api/documents/doc1/lease";
    const payload = JSON.stringify({ action: "release", clientId: creds.clientId, leaseToken: creds.leaseToken, generation: creds.generation });
    // Stub globals via defineProperty to avoid read-only error
    const origDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { sendBeacon: beaconMock }, writable: true, configurable: true });
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const dispatched = dispatchRelease(url, payload, released, key);
    expect(dispatched).toBe(true);
    expect(beaconCalls).toBe(1);
    expect(fetchCalls).toBe(1);
    expect(released.has(key)).toBe(true);
    beaconCalls = 0; fetchCalls = 0;
    expect(dispatchRelease(url, payload, released, key)).toBe(false);
    expect(beaconCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    const creds2: EditLeaseCredentials = { clientId: "c1", leaseToken: "t2", generation: 2 };
    const key2 = credentialKey(creds2);
    const payload2 = JSON.stringify({ action: "release", clientId: creds2.clientId, leaseToken: creds2.leaseToken, generation: creds2.generation });
    expect(dispatchRelease(url, payload2, released, key2)).toBe(true);
    expect(released.has(key2)).toBe(true);
    if (origDesc) Object.defineProperty(globalThis, "navigator", origDesc);
    else delete (globalThis as unknown as { navigator?: unknown }).navigator;
    globalThis.fetch = origFetch;
  });
});
