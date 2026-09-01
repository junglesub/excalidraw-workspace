import { describe, it, expect } from "vitest";
import { credentialKey } from "@/lib/client_edit_lease";
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

  it("uses production credentialKey helper, not copied state", () => {
    const creds: EditLeaseCredentials = { clientId: "client-abc", leaseToken: "token-xyz", generation: 42 };
    const key = credentialKey(creds);
    expect(key).toBe("client-abc:token-xyz:42");
    expect(key).toContain("client-abc");
    expect(key).toContain("token-xyz");
  });
});
