import { describe, expect, it, vi } from "vitest";
import {
  canMoveFolderTo,
  executeDocumentMoves,
  filterMovableDocumentIds,
  getDisambiguatedChildFolders,
  getExcludedFolderIds,
  getFolderBreadcrumbsFromList,
  reconcileSelectionAfterMove,
  resolveDragDocumentIds,
  shouldTriggerNavigationFeedback,
  type FolderNode,
  type MovableDoc,
} from "@/lib/dashboard_document_move";

const sampleDocs: MovableDoc[] = [
  { id: "doc-1", folder_id: null, permission: "OWNER" },
  { id: "doc-2", folder_id: null, permission: "OWNER" },
  { id: "doc-3", folder_id: "folder-a", permission: "OWNER" },
  { id: "doc-shared", folder_id: null, permission: "EDITOR" },
];

describe("dashboard document selection and move helpers", () => {
  it("resolves selected group when dragging a selected document and single doc when unselected", () => {
    expect(resolveDragDocumentIds("doc-1", ["doc-1", "doc-2"], sampleDocs)).toEqual(["doc-1", "doc-2"]);
    expect(resolveDragDocumentIds("doc-2", ["doc-1"], sampleDocs)).toEqual(["doc-2"]);
    expect(resolveDragDocumentIds("doc-shared", ["doc-shared", "doc-1"], sampleDocs)).toEqual([]);
  });

  it("filters out non-owned, stale, and already-in-target documents", () => {
    expect(filterMovableDocumentIds(["doc-1", "doc-shared", "missing", "doc-1"], "folder-a", sampleDocs)).toEqual([
      "doc-1",
    ]);
    // Dropping into current folder (null for doc-1, folder-a for doc-3) is a no-op
    expect(filterMovableDocumentIds(["doc-1", "doc-2"], null, sampleDocs)).toEqual([]);
    expect(filterMovableDocumentIds(["doc-3"], "folder-a", sampleDocs)).toEqual([]);
  });

  it("reconciles partial failures so failed selections remain retryable", async () => {
    const moveOne = vi.fn(async (id: string) => {
      if (id === "doc-2") throw new Error("Destination folder not found");
    });

    const result = await executeDocumentMoves(["doc-1", "doc-2"], "folder-b", sampleDocs, moveOne);
    expect(moveOne).toHaveBeenCalledTimes(2);
    expect(result.succeededIds).toEqual(["doc-1"]);
    expect(result.failed).toEqual([{ id: "doc-2", message: "Destination folder not found" }]);
    expect(result.errorMessage).toContain("Moved 1 of 2 documents");
    expect(reconcileSelectionAfterMove(["doc-1", "doc-2"], result.succeededIds)).toEqual(["doc-2"]);
  });

  it("does nothing when all targeted documents are already in the target folder", async () => {
    const moveOne = vi.fn(async () => {});
    const result = await executeDocumentMoves(["doc-1", "doc-2"], null, sampleDocs, moveOne);
    expect(moveOne).not.toHaveBeenCalled();
    expect(result.attemptedIds).toEqual([]);
    expect(result.errorMessage).toBeNull();
  });

  it("triggers navigation feedback only on unmodified primary activations", () => {
    const base = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(shouldTriggerNavigationFeedback(base)).toBe(true);
    expect(shouldTriggerNavigationFeedback({ ...base, metaKey: true })).toBe(false);
    expect(shouldTriggerNavigationFeedback({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldTriggerNavigationFeedback({ ...base, shiftKey: true })).toBe(false);
    expect(shouldTriggerNavigationFeedback({ ...base, altKey: true })).toBe(false);
    expect(shouldTriggerNavigationFeedback({ ...base, button: 1 })).toBe(false);
    expect(shouldTriggerNavigationFeedback({ ...base, defaultPrevented: true })).toBe(false);
  });

  it("validates folder move targets against self, descendants, current parent, and unknown targets", () => {
    const folders: FolderNode[] = [
      { id: "f1", name: "Projects", parent_id: null },
      { id: "f2", name: "2026", parent_id: "f1" },
      { id: "f3", name: "Q4", parent_id: "f2" },
      { id: "f4", name: "Archive", parent_id: null },
    ];
    expect(Array.from(getExcludedFolderIds("f1", folders)).sort()).toEqual(["f1", "f2", "f3"]);
    expect(canMoveFolderTo("f1", null, "f1", folders)).toBe(false);
    expect(canMoveFolderTo("f1", null, "f2", folders)).toBe(false);
    expect(canMoveFolderTo("f1", null, "f3", folders)).toBe(false);
    expect(canMoveFolderTo("f1", null, null, folders)).toBe(false); // current parent
    expect(canMoveFolderTo("f1", null, "unknown", folders)).toBe(false);
    expect(canMoveFolderTo("f1", null, "f4", folders)).toBe(true);
    expect(canMoveFolderTo("f2", "f1", null, folders)).toBe(true); // move nested folder to root
  });

  it("builds breadcrumbs and disambiguates duplicate sibling folder names for the move browser", () => {
    const folders: FolderNode[] = [
      { id: "f1", name: "Work", parent_id: null },
      { id: "f2", name: "Work", parent_id: null },
      { id: "f3", name: "Specs", parent_id: "f1" },
    ];
    expect(getFolderBreadcrumbsFromList("f3", folders).map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(getFolderBreadcrumbsFromList(null, folders)).toEqual([]);

    const excluded = getExcludedFolderIds("f1", folders);
    expect(getDisambiguatedChildFolders(null, folders, excluded)).toEqual([
      { id: "f1", name: "Work", displayName: "Work (1)", disabled: true },
      { id: "f2", name: "Work", displayName: "Work (2)", disabled: false },
    ]);
  });
});
