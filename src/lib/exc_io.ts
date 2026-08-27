import type { ExcalidrawScene } from "./types";
import { emptyScene } from "./types";
import { HttpError } from "./http";

/**
 * Standard .excalidraw format is the ExcalidrawScene JSON payload.
 * We never lock data into an internal format; the exported file uses the same
 * shape the official Excalidraw application accepts.
 */

export function exportSceneAsExcalidrawJson(scene: ExcalidrawScene): string {
  return JSON.stringify(scene, null, 2);
}

/**
 * Parse the content of a .excalidraw file into a normalized scene.
 * Accepts both the bare scene object and a wrapper. Rejects non-scene input.
 */
export function importExcalidrawJson(content: string): ExcalidrawScene {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new HttpError(400, "Invalid .excalidraw file: not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(400, "Invalid .excalidraw file");
  }
  const obj = parsed as Record<string, unknown>;
  // Normalize: some exporters wrap in { type, version, elements, appState, files } directly.
  const elements = Array.isArray(obj.elements)
    ? obj.elements
    : Array.isArray((obj as Record<string, unknown>)["data"])
      ? ((obj as Record<string, unknown>)["data"] as unknown[])
      : [];
  const appState =
    obj.appState && typeof obj.appState === "object" ? (obj.appState as Record<string, unknown>) : {};
  const files = obj.files && typeof obj.files === "object" ? (obj.files as Record<string, unknown>) : {};

  const scene: ExcalidrawScene = {
    type: typeof obj.type === "string" ? obj.type : "excalidraw",
    version: typeof obj.version === "number" ? obj.version : 2,
    elements,
    appState,
    files,
  };
  if (!elements.length && !Object.keys(files).length && !Object.keys(appState).length) {
    return emptyScene();
  }
  return scene;
}

export const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";
export const EXCALIDRAW_EXT = ".excalidraw";