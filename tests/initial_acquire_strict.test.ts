import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createDocument } from "@/lib/documents";
import { createUser } from "@/lib/users";
import { acquireEditLease, releaseEditLease } from "@/lib/edit_lease";
import { emptyScene } from "@/lib/types";

describe("Initial acquire strict mode false-conflict regression", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("two concurrent acquire requests with different tokens from same user+clientId produce a false held (the bug)", () => {
    const user = createUser("owner", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const now = new Date();
    const clientId = "c1";

    // Timeline: Effect A starts acquire with token "tA", Effect B (Strict Mode replay)
    // concurrently starts acquire with token "tB". Both see an empty lease row.
    const resultA = acquireEditLease(
      { docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId, leaseToken: "tA" },
      now,
    );
    expect(resultA.state).toBe("acquired");
    const genA = (resultA as { generation: number }).generation;

    // Request B arrives at server when the lease is already owned by same user+clientId but
    // with a different token and no prior credentials -> held (false positive).
    const resultB = acquireEditLease(
      { docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId, leaseToken: "tB" },
      new Date(now.getTime() + 10),
    );
    expect(resultB.state).toBe("held");

    // A's cancelled handler releases the lease (line 356 of EditorClient)
    if (resultA.state === "acquired") {
      const releaseRes = releaseEditLease(
        { docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId, leaseToken: "tA", generation: genA },
        new Date(now.getTime() + 20),
      );
      expect(releaseRes.state).toBe("released");
    }

    // Now B's handler sees "held" in the result (cached) — the lease was already released
    // by A, but B's client already has the held response. The user sees "already editing".
    // This is the false positive.
    expect(resultB.state).toBe("held");
    if (resultB.state === "held") {
      expect((resultB as { holder: { username: string } }).holder.username).toBe("owner");
    }

    // After A's release, the server is clean (no holder). But the client never retries.
    const fresh = acquireEditLease(
      { docId: doc.id, userId: user.id, role: "USER", adminMode: false, clientId, leaseToken: "tC" },
      new Date(now.getTime() + 30),
    );
    expect(fresh.state).toBe("acquired");
  });
});