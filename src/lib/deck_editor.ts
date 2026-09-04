export type PageMoveDirection = "previous" | "next";

export function movePageId(
  pageIds: string[],
  activeId: string | null,
  direction: PageMoveDirection,
): string | null {
  if (pageIds.length === 0) return null;
  const index = activeId ? pageIds.indexOf(activeId) : -1;
  if (index < 0) return pageIds[0];
  if (direction === "previous") return pageIds[Math.max(0, index - 1)];
  return pageIds[Math.min(pageIds.length - 1, index + 1)];
}

export function validateReorder(currentIds: string[], requestedIds: string[]): boolean {
  if (currentIds.length !== requestedIds.length) return false;
  if (new Set(requestedIds).size !== requestedIds.length) return false;
  const current = new Set(currentIds);
  return requestedIds.every((id) => current.has(id));
}

import type { DeckAspectRatio } from "@/lib/types";

export type DeckEditorChrome = {
  layout: "portrait" | "landscape";
  toolbar: "vertical" | "horizontal";
};

export function deckEditorChrome(aspectRatio: DeckAspectRatio): DeckEditorChrome {
  return aspectRatio === "9:16"
    ? { layout: "portrait", toolbar: "vertical" }
    : { layout: "landscape", toolbar: "horizontal" };
}
