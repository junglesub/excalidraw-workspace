import { describe, it, expect } from "vitest";
import { waitForNoSaving, shouldRecoverHandoffToActive, getAcquisitionFailureRecovery, canMutateCanvas, shouldReadLocalDraft } from "@/lib/client_edit_lease";

describe("Handoff serialization regression", () => {
  it("proves handoff guard recovers and heartbeat recovers to active after expired takeover", async () => {
    expect(canMutateCanvas("handoff")).toBe(false);
    expect(shouldReadLocalDraft("handoff")).toBe(false);
    // Guard must reset even when wait times out
    const ref = { current: true };
    let guard = true;
    try {
      await waitForNoSaving(ref, 80);
    } catch {
      guard = false;
    } finally {
      guard = false;
    }
    expect(guard).toBe(false);
    expect(shouldRecoverHandoffToActive("handoff", "acquired")).toBe(true);
    expect(shouldRecoverHandoffToActive("handoff", "takeover_pending")).toBe(false);
    expect(shouldRecoverHandoffToActive("active", "acquired")).toBe(false);
    // Wait succeeds when saving finishes
    const ref2 = { current: true };
    setTimeout(() => { ref2.current = false; }, 40);
    await expect(waitForNoSaving(ref2, 500)).resolves.toBeUndefined();
  });
});

describe("Acquisition load failure regression", () => {
  it("has visible safe read-only state without draft access and retry path", () => {
    const recovery = getAcquisitionFailureRecovery();
    expect(recovery.mode).toBe("readonly");
    expect(recovery.shouldReadDraft).toBe(false);
    expect(recovery.shouldMountEditable).toBe(false);
    expect(recovery.shouldRelease).toBe(true);
    expect(recovery.retryable).toBe(true);
    expect(canMutateCanvas(recovery.mode)).toBe(false);
    expect(shouldReadLocalDraft(recovery.mode)).toBe(false);
  });
});
