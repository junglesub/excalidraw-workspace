import { describe, expect, it, vi } from "vitest";
import {
  fullscreenAvailable,
  isFullscreenActive,
  isStandaloneDisplay,
  togglePresentationFullscreen,
} from "@/lib/presentation_fullscreen";
import manifest from "@/app/manifest";
import { readFileSync } from "node:fs";

describe("presentation fullscreen", () => {
  it("detects native fullscreen and standalone display independently", () => {
    expect(fullscreenAvailable({ fullscreenEnabled: true })).toBe(true);
    expect(fullscreenAvailable({ fullscreenEnabled: false })).toBe(false);
    expect(isFullscreenActive({ fullscreenElement: {} as Element })).toBe(true);
    expect(isFullscreenActive({ fullscreenElement: null })).toBe(false);
    expect(isStandaloneDisplay({ mediaMatches: true, navigatorStandalone: false })).toBe(true);
    expect(isStandaloneDisplay({ mediaMatches: false, navigatorStandalone: true })).toBe(true);
  });

  it("enters and exits fullscreen and treats unsupported mode as non-blocking", async () => {
    const requestFullscreen = vi.fn(async () => {});
    const exitFullscreen = vi.fn(async () => {});
    expect(await togglePresentationFullscreen(
      { fullscreenEnabled: true, fullscreenElement: null, exitFullscreen } as never,
      { requestFullscreen } as never,
    )).toBe("entered");
    expect(requestFullscreen).toHaveBeenCalledOnce();

    expect(await togglePresentationFullscreen(
      { fullscreenEnabled: true, fullscreenElement: {} as Element, exitFullscreen } as never,
      { requestFullscreen } as never,
    )).toBe("exited");
    expect(exitFullscreen).toHaveBeenCalledOnce();

    expect(await togglePresentationFullscreen(
      { fullscreenEnabled: false, fullscreenElement: null, exitFullscreen } as never,
      { requestFullscreen } as never,
    )).toBe("unsupported");
  });

  it("declares standalone web-app presentation metadata", () => {
    const data = manifest();
    expect(data.name).toBe("Excalidraw Workspace");
    expect(data.short_name).toBe("Excalidraw Workspace");
    expect(data.display).toBe("standalone");
    expect(data.start_url).toBe("/dashboard");
    expect(data.icons?.length).toBeGreaterThan(0);
  });

  it("exposes fullscreen UI in Present Mode", () => {
    const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
    expect(source).toContain('aria-label="Full screen"');
    expect(source).toContain("togglePresentationFullscreen");
    expect(source).toContain("fullscreenchange");
  });
});
