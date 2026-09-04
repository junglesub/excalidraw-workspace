import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deckEditorChrome, movePageId, validateReorder } from "@/lib/deck_editor";

describe("deck editor model", () => {
  it("moves to adjacent pages without wrapping", () => {
    const ids = ["a", "b", "c"];
    expect(movePageId(ids, "b", "previous")).toBe("a");
    expect(movePageId(ids, "b", "next")).toBe("c");
    expect(movePageId(ids, "a", "previous")).toBe("a");
    expect(movePageId(ids, "c", "next")).toBe("c");
  });

  it("falls back to the first page when the active page is missing", () => {
    expect(movePageId(["a", "b"], "missing", "next")).toBe("a");
    expect(movePageId([], "missing", "next")).toBeNull();
  });

  it("accepts reorder only when every existing page appears exactly once", () => {
    expect(validateReorder(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
    expect(validateReorder(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(validateReorder(["a", "b", "c"], ["a", "b", "b"])).toBe(false);
    expect(validateReorder(["a", "b", "c"], ["a", "b", "x"])).toBe(false);
  });
  it("maps Deck aspect ratio to editor chrome orientation", () => {
    expect(deckEditorChrome("9:16")).toEqual({ layout: "portrait", toolbar: "vertical" });
    expect(deckEditorChrome("16:9")).toEqual({ layout: "landscape", toolbar: "horizontal" });
  });

  it("uses inline page editing instead of navigating to a standalone document editor", () => {
    const source = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    expect(source).toContain("EmbeddedPageEditor");
    expect(source).not.toContain("Edit page");
    expect(source).not.toContain("/documents/${activePage.documentId}");
  });

});
