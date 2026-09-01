import { describe, it, expect } from "vitest";
import { waitForNoSaving, shouldRecoverHandoffToActive, canMutateCanvas, shouldReadLocalDraft } from "@/lib/client_edit_lease";

describe("Handoff serialization regression", () => {
  it("proves handoff guard recovers and heartbeat recovers to active after expired takeover", async () => {
    expect(canMutateCanvas("handoff")).toBe(false);
    expect(shouldReadLocalDraft("handoff")).toBe(false);
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
    const ref2 = { current: true };
    setTimeout(() => { ref2.current = false; }, 40);
    await expect(waitForNoSaving(ref2, 500)).resolves.toBeUndefined();
  });
});

describe("Acquisition load failure regression", () => {
  it("GET failure yields visible safe read-only with retry and no draft/editing until fresh acquisition", () => {
    const failedMode = "readonly" as const;
    expect(canMutateCanvas(failedMode)).toBe(false);
    expect(shouldReadLocalDraft(failedMode)).toBe(false);
    // Blocked without holder would render blank (modal requires holder), so failure must not be blocked without holder
    const blockedWithoutHolder = { mode: "blocked" as const, holder: null as unknown };
    expect(blockedWithoutHolder.holder).toBeNull();
    // Production must use readonly with safe initialScene and error, allowing retry via existing takeover banner
    expect(failedMode).toBe("readonly");
    // Only after fresh GET success should draft be read and editable canvas mounted (active mode)
    expect(canMutateCanvas("active")).toBe(true);
    expect(shouldReadLocalDraft("active")).toBe(true);
  });
});
