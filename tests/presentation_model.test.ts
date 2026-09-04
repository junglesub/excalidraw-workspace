import { describe, expect, it } from "vitest";
import {
  presentationPointerTool,
  presentationTouchHitsSelectionBounds,
  presentationToolType,
  nextPresentationPageId,
  isConfirmedDoubleTap,
} from "@/lib/presentation";

describe("presentation model", () => {
  it("maps presentation tools to Excalidraw tools", () => {
    expect(presentationToolType("pen")).toBe("freedraw");
    expect(presentationToolType("laser")).toBe("laser");
  });

  it("routes touch off, selection hits, and empty-space touch correctly", () => {
    expect(presentationPointerTool("pen", false, false, false, "laser")).toBe("laser");
    expect(presentationPointerTool("touch", false, false, false, "pen")).toBe("pen");
    expect(presentationPointerTool("touch", false, false, false, "laser")).toBe("laser");
    expect(presentationPointerTool("touch", false, false, false, "rectangle")).toBe("rectangle");
    expect(presentationPointerTool("touch", false, false, false, "ellipse")).toBe("ellipse");
    expect(presentationPointerTool("touch", true, false, false, "pen")).toBeNull();
    expect(presentationPointerTool("touch", true, true, true, "pen")).toBe("select");
    expect(presentationPointerTool("touch", true, true, false, "eraser")).toBe("eraser");
  });

  it("treats only the selection outline and nearby handles as selection interaction", () => {
    const bounds = [100, 100, 200, 200] as const;
    expect(presentationTouchHitsSelectionBounds({ x: 150, y: 150 }, bounds, 1)).toBe(false);
    expect(presentationTouchHitsSelectionBounds({ x: 115, y: 150 }, bounds, 1)).toBe(true);
    expect(presentationTouchHitsSelectionBounds({ x: 85, y: 150 }, bounds, 1)).toBe(true);
    expect(presentationTouchHitsSelectionBounds({ x: 50, y: 150 }, bounds, 1)).toBe(false);
    expect(presentationTouchHitsSelectionBounds({ x: 92, y: 150 }, bounds, 2)).toBe(true);
    expect(presentationTouchHitsSelectionBounds({ x: 80, y: 150 }, bounds, 2)).toBe(false);
  });

  it("confirms a destructive action only on a second tap inside the window", () => {
    expect(isConfirmedDoubleTap(null, 1000)).toBe(false);
    expect(isConfirmedDoubleTap(1000, 2500)).toBe(true);
    expect(isConfirmedDoubleTap(1000, 3101)).toBe(false);
  });

  it("moves without wrapping and falls back to the first page", () => {
    const ids = ["a", "b", "c"];
    expect(nextPresentationPageId(ids, "b", "previous")).toBe("a");
    expect(nextPresentationPageId(ids, "b", "next")).toBe("c");
    expect(nextPresentationPageId(ids, "a", "previous")).toBe("a");
    expect(nextPresentationPageId(ids, "c", "next")).toBe("c");
    expect(nextPresentationPageId(ids, "missing", "next")).toBe("a");
    expect(nextPresentationPageId([], null, "next")).toBeNull();
  });
});

it("maps presentation eraser to the Excalidraw eraser tool", async () => {
  const { presentationToolType } = await import("@/lib/presentation");
  expect(presentationToolType("eraser" as never)).toBe("eraser");
});

it("maps presentation select to the Excalidraw selection tool", async () => {
  const { presentationToolType } = await import("@/lib/presentation");
  expect(presentationToolType("select" as never)).toBe("selection");
});

it("ignores Present viewport/tool-only scene changes for dirty detection", async () => {
  const { presentationSceneContentChanged } = await import("@/lib/presentation");
  const before = {
    type: "excalidraw" as const,
    version: 2,
    elements: [{ id: "a", type: "rectangle", isDeleted: false }],
    appState: { viewBackgroundColor: "#ffffff", scrollX: 0 },
    files: {},
  };
  const viewportOnly = {
    ...before,
    appState: { viewBackgroundColor: "#ffffff", scrollX: 100, activeTool: { type: "freedraw" } },
  };
  const drawingChange = {
    ...before,
    elements: [...before.elements, { id: "b", type: "freedraw", isDeleted: false }],
  };

  expect(presentationSceneContentChanged(before, viewportOnly)).toBe(false);
  expect(presentationSceneContentChanged(before, drawingChange)).toBe(true);
});


it("maps Present rectangle and ellipse tools to Excalidraw shapes", async () => {
  const { presentationToolType } = await import("@/lib/presentation");
  expect(presentationToolType("rectangle" as never)).toBe("rectangle");
  expect(presentationToolType("ellipse" as never)).toBe("ellipse");
});
