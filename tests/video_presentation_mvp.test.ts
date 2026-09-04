import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createUser } from "@/lib/users";
import { createBlankPage, createDeck, getDeck } from "@/lib/decks";
import { getDocumentWithScene, updateScene } from "@/lib/documents";
import { emptyScene, type ExcalidrawScene } from "@/lib/types";
import { nextPresentationPageId, presentationToolType } from "@/lib/presentation";
import { resetRecordingBaseline, setRecordingBaseline } from "@/lib/presentation_snapshots";

function sceneWith(element: Record<string, unknown>): ExcalidrawScene {
  return { ...emptyScene(), elements: [element] };
}

function sceneElementIds(documentId: string, userId: string): string[] {
  return (getDocumentWithScene(documentId, userId, "USER").scene.elements as Array<{ id: string }>).map((item) => item.id);
}

describe("video presentation MVP automated validation", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("restores all ten baseline pages and retains a page created after the baseline", () => {
    const user = createUser("mvp-ten-page", "pass123", "USER");
    const created = createDeck(user.id, "Ten page take", "16:9");
    for (let index = 1; index < 10; index += 1) {
      createBlankPage(created.id, user.id, "USER");
    }
    const tenPages = getDeck(created.id, user.id, "USER").pages;
    expect(tenPages).toHaveLength(10);

    tenPages.forEach((page, index) => {
      updateScene(page.documentId, sceneWith({ id: `baseline-${index + 1}`, type: "rectangle", isDeleted: false }), user.id, "USER");
    });
    const baseline = setRecordingBaseline(created.id, user.id, "USER");
    expect(baseline.pages).toHaveLength(10);

    tenPages.forEach((page, index) => {
      updateScene(page.documentId, sceneWith({ id: `pen-${index + 1}`, type: "freedraw", isDeleted: false }), user.id, "USER");
    });
    const later = createBlankPage(created.id, user.id, "USER");
    updateScene(later.documentId, sceneWith({ id: "post-baseline", type: "rectangle", isDeleted: false }), user.id, "USER");

    const result = resetRecordingBaseline(created.id, { scope: "all" }, user.id, "USER");

    expect(result.restoredPageIds).toHaveLength(10);
    expect(result.skippedPageIds).toEqual([]);
    tenPages.forEach((page, index) => {
      expect(sceneElementIds(page.documentId, user.id)).toEqual([`baseline-${index + 1}`]);
    });
    expect(sceneElementIds(later.documentId, user.id)).toEqual(["post-baseline"]);
    expect(getDeck(created.id, user.id, "USER").pages).toHaveLength(11);
  });

  it("persists Pen annotations while navigating away and back", () => {
    const user = createUser("mvp-pen-persist", "pass123", "USER");
    const created = createDeck(user.id, "Pen persistence", "16:9");
    const second = createBlankPage(created.id, user.id, "USER");
    const pages = getDeck(created.id, user.id, "USER").pages;
    const first = pages[0];

    expect(presentationToolType("pen")).toBe("freedraw");
    updateScene(first.documentId, sceneWith({ id: "present-pen", type: "freedraw", isDeleted: false }), user.id, "USER");

    const nextId = nextPresentationPageId(pages.map((page) => page.id), first.id, "next");
    expect(nextId).toBe(second.id);
    const previousId = nextPresentationPageId(pages.map((page) => page.id), nextId, "previous");
    expect(previousId).toBe(first.id);
    expect(sceneElementIds(first.documentId, user.id)).toEqual(["present-pen"]);

    const presentSource = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
    expect(presentSource).toMatch(/async function navigate[\s\S]*await saveCurrent\(\);[\s\S]*setActivePageId\(target\)/);
    expect(presentSource).not.toMatch(/async function navigate[\s\S]*releaseCurrent/);
  });

  it("renders Laser as a transient Present overlay instead of a persisted annotation element", () => {
    expect(presentationToolType("laser")).toBe("laser");
    const canvasSource = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
    expect(canvasSource).toContain("presentation-laser-overlay");
    expect(canvasSource).toContain('tool === "laser"');
    expect(canvasSource).not.toContain('type: "laser", isDeleted');
    expect(canvasSource).not.toContain('type: "laser" as');
  });
});
