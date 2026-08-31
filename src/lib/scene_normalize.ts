import type { ExcalidrawScene } from "./types";

/**
 * Server-safe pure helpers for normalized scene comparison.
 * Semantics: active images only, sorted files, viewBackgroundColor, ignore dataURL.
 * Used by both client draft/dirty detection and server manual Save.
 */

function compactFileMetadata(fileId: string, fileObj: Record<string, unknown>): Record<string, unknown> {
  return {
    id: fileId,
    mimeType: (fileObj.mimeType as string) || "image/png",
    created: (fileObj.created as number) || 0,
    ...(fileObj.version ? { version: fileObj.version } : {}),
  };
}

export function getActiveImageFileIds(scene: ExcalidrawScene): Set<string> {
  const activeIds = new Set<string>();
  if (Array.isArray(scene.elements)) {
    for (const el of scene.elements) {
      if (el && typeof el === "object") {
        const item = el as Record<string, unknown>;
        if (item.type === "image" && !item.isDeleted && typeof item.fileId === "string" && item.fileId) {
          activeIds.add(item.fileId);
        }
      }
    }
  }
  return activeIds;
}

export function buildCompactScene(scene: ExcalidrawScene): ExcalidrawScene {
  const activeFileIds = getActiveImageFileIds(scene);
  const compactFiles: Record<string, Record<string, unknown>> = {};
  if (scene.files && typeof scene.files === "object") {
    for (const [fileId, fileObj] of Object.entries(scene.files as Record<string, Record<string, unknown>>)) {
      if (!fileObj || typeof fileObj !== "object") continue;
      if (!activeFileIds.has(fileId)) continue;
      compactFiles[fileId] = compactFileMetadata(fileId, fileObj);
    }
  }
  return {
    ...scene,
    files: compactFiles,
  };
}

export function serializeForComparison(scene: ExcalidrawScene): string {
  const compact = buildCompactScene(scene);
  const sortedFiles = Object.fromEntries(
    Object.entries(compact.files || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    elements: Array.isArray(compact.elements) ? compact.elements : [],
    files: sortedFiles,
    viewBackgroundColor:
      (compact.appState as Record<string, unknown> | undefined)?.viewBackgroundColor || "#ffffff",
  });
}

// Backwards-compatible aliases
export const serializeSceneForComparison = serializeForComparison;
export const buildCompactClientScene = buildCompactScene;
