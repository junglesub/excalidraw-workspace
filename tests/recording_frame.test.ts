import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { recordingFrameForAspectRatio } from "@/lib/recording_frame";

describe("recording frame", () => {
  it("uses fixed 16:9 scene bounds", () => {
    expect(recordingFrameForAspectRatio("16:9")).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
  });

  it("uses fixed 9:16 scene bounds", () => {
    expect(recordingFrameForAspectRatio("9:16")).toEqual({ x: 0, y: 0, width: 900, height: 1600 });
  });

  it("wires the shared frame into Deck editing and Present Mode", () => {
    const editor = readFileSync("src/components/ExcalidrawCanvas.tsx", "utf8");
    const embedded = readFileSync("src/app/decks/[id]/EmbeddedPageEditor.tsx", "utf8");
    const presentation = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
    expect(editor).toContain("recordingFrameAspectRatio");
    expect(editor).toContain("recordingFrameForAspectRatio");
    expect(embedded).toContain("recordingFrameAspectRatio");
    expect(presentation).toContain("recordingFrameSkeleton");
  });
});

import { recordingFrameFitOptions } from "@/lib/recording_frame";

it("maximizes Reset View fit while keeping Present camera capped", () => {
  expect(recordingFrameFitOptions("editor")).toEqual({ fitToViewport: true, viewportZoomFactor: 1, animate: false });
  expect(recordingFrameFitOptions("present")).toEqual({ fitToViewport: true, viewportZoomFactor: 1, maxZoom: 1, animate: false });
});
