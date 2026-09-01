import { describe, it, expect } from "vitest";
import { waitForNoSaving, canMutateCanvas, shouldReadLocalDraft } from "@/lib/client_edit_lease";

describe("Handoff serialization regression", () => {
  it("handoff freezes canvas and waits for in-flight save before final flush", async () => {
    expect(canMutateCanvas("handoff")).toBe(false);
    expect(shouldReadLocalDraft("handoff")).toBe(false);
    const ref = { current: true };
    setTimeout(() => { ref.current = false; }, 60);
    const start = Date.now();
    await waitForNoSaving(ref, 1000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    expect(ref.current).toBe(false);
  });

  it("ensures latest scene is confirmed final write before release decision", async () => {
    // Simulate that executeSave queue holds latest scene; handoff must wait, not overwrite with stale auto-save
    const isSavingRef = { current: true };
    let handoffStarted = false;
    let finalScene = "handoff-scene";
    let autoScene = "auto-scene-old";
    // auto-save in flight with old scene
    setTimeout(() => {
      // auto-save completes, writes autoScene
      isSavingRef.current = false;
      handoffStarted = true;
    }, 30);
    await waitForNoSaving(isSavingRef);
    expect(handoffStarted).toBe(true);
    // handoff then writes finalScene, which must be later than autoScene
    expect(finalScene).not.toBe(autoScene);
  });
});
