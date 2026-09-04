import type { ExcalidrawScene } from "./types";
import { serializeForComparison } from "./scene_normalize";

export type PresentationTool = "select" | "pen" | "rectangle" | "ellipse" | "eraser" | "laser";
export type PresentationDirection = "previous" | "next";

export function presentationToolType(tool: PresentationTool): "selection" | "freedraw" | "rectangle" | "ellipse" | "eraser" | "laser" {
  if (tool === "select") return "selection";
  if (tool === "pen") return "freedraw";
  if (tool === "rectangle") return "rectangle";
  if (tool === "ellipse") return "ellipse";
  if (tool === "eraser") return "eraser";
  return "laser";
}

export function presentationPointerTool(
  pointerType: string,
  penDetected: boolean,
  touchEnabled: boolean,
  selectionHit: boolean,
  activeTool: PresentationTool,
): PresentationTool | null {
  if (pointerType === "touch") {
    if (selectionHit) return "select";
    if (!penDetected) return activeTool;
    if (!touchEnabled) return null;
    return activeTool;
  }
  if (pointerType === "pen" && selectionHit) return "select";
  return activeTool;
}

export function presentationTouchHitsSelectionBounds(
  point: { x: number; y: number },
  bounds: readonly [number, number, number, number],
  zoom: number,
  marginPx = 24,
): boolean {
  const margin = marginPx / Math.max(zoom, 0.01);
  const [x1, y1, x2, y2] = bounds;
  const insideOuter = point.x >= x1 - margin
    && point.x <= x2 + margin
    && point.y >= y1 - margin
    && point.y <= y2 + margin;
  if (!insideOuter) return false;

  const innerX1 = x1 + margin;
  const innerY1 = y1 + margin;
  const innerX2 = x2 - margin;
  const innerY2 = y2 - margin;
  const hasInterior = innerX1 < innerX2 && innerY1 < innerY2;
  const insideInterior = hasInterior
    && point.x > innerX1
    && point.x < innerX2
    && point.y > innerY1
    && point.y < innerY2;

  return !insideInterior;
}

export function scenePointForPointer(
  point: { clientX: number; clientY: number },
  appState: {
    zoom: { value: number };
    offsetLeft: number;
    offsetTop: number;
    scrollX: number;
    scrollY: number;
  },
): { x: number; y: number } {
  const zoom = Math.max(appState.zoom.value, 0.01);
  return {
    x: (point.clientX - appState.offsetLeft) / zoom - appState.scrollX,
    y: (point.clientY - appState.offsetTop) / zoom - appState.scrollY,
  };
}

export function presentationElementsBounds(
  elements: readonly { x: number; y: number; width: number; height: number; angle?: number }[],
): readonly [number, number, number, number] {
  if (elements.length === 0) return [0, 0, 0, 0];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const x1 = element.x;
    const y1 = element.y;
    const x2 = element.x + element.width;
    const y2 = element.y + element.height;
    const angle = element.angle ?? 0;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] as const;

    for (const [x, y] of corners) {
      const dx = x - cx;
      const dy = y - cy;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      minX = Math.min(minX, rx);
      minY = Math.min(minY, ry);
      maxX = Math.max(maxX, rx);
      maxY = Math.max(maxY, ry);
    }
  }

  return [minX, minY, maxX, maxY];
}

export function isConfirmedDoubleTap(
  armedAt: number | null,
  now: number,
  windowMs = 2_000,
): boolean {
  return armedAt !== null && now >= armedAt && now - armedAt <= windowMs;
}

export function nextPresentationPageId(
  pageIds: string[],
  activePageId: string | null,
  direction: PresentationDirection,
): string | null {
  if (pageIds.length === 0) return null;
  const index = activePageId ? pageIds.indexOf(activePageId) : -1;
  if (index < 0) return pageIds[0];
  if (direction === "previous") return pageIds[Math.max(0, index - 1)];
  return pageIds[Math.min(pageIds.length - 1, index + 1)];
}

export function presentationSceneContentChanged(
  previous: ExcalidrawScene,
  next: ExcalidrawScene,
): boolean {
  return serializeForComparison(previous) !== serializeForComparison(next);
}
