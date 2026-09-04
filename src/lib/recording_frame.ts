import type { DeckAspectRatio } from "./types";

export interface RecordingFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FRAMES: Record<DeckAspectRatio, RecordingFrameRect> = {
  "16:9": { x: 0, y: 0, width: 1600, height: 900 },
  "9:16": { x: 0, y: 0, width: 900, height: 1600 },
};

export function recordingFrameForAspectRatio(aspectRatio: DeckAspectRatio): RecordingFrameRect {
  return { ...FRAMES[aspectRatio] };
}

export function recordingFrameSkeleton(aspectRatio: DeckAspectRatio) {
  const frame = recordingFrameForAspectRatio(aspectRatio);
  return {
    type: "rectangle" as const,
    ...frame,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 1,
    strokeStyle: "solid" as const,
    roughness: 0,
    opacity: 0,
  };
}

export function recordingFrameFitOptions(mode: "editor" | "present") {
  if (mode === "present") {
    return {
      fitToViewport: true as const,
      viewportZoomFactor: 1,
      maxZoom: 1,
      animate: false,
    };
  }
  return {
    fitToViewport: true as const,
    viewportZoomFactor: 1,
    animate: false,
  };
}
