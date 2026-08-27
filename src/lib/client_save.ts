import type { ExcalidrawScene } from "./types";
import { blobToDataURL } from "./client_attachments";

export interface SaveDocumentOptions {
  docId: string;
  scene: ExcalidrawScene;
  persistedFileIds: Set<string>;
  isManualSave?: boolean;
  snapshotDue?: boolean;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export interface SaveDocumentResult {
  ok: boolean;
  snapshotCreated?: boolean;
  updatedAt?: string;
  versions?: unknown[];
  snapshot?: unknown;
}

function compactFileMetadata(fileId: string, fileObj: Record<string, unknown>): Record<string, unknown> {
  return {
    id: fileId,
    mimeType: (fileObj.mimeType as string) || "image/png",
    created: (fileObj.created as number) || 0,
    ...(fileObj.version ? { version: fileObj.version } : {}),
  };
}

/**
 * Deterministically serializes scene content for dirty state comparison.
 * Inline dataURLs are ignored so client hydration does not look like an edit.
 */
export function serializeSceneForComparison(s: ExcalidrawScene): string {
  const compact = buildCompactClientScene(s);
  return JSON.stringify({
    elements: Array.isArray(compact.elements) ? compact.elements : [],
    files: compact.files || {},
    viewBackgroundColor:
      (compact.appState as Record<string, unknown> | undefined)?.viewBackgroundColor || "#ffffff",
  });
}

/**
 * Compares the scene that was just saved against the latest scene in memory.
 * Returns isDirty: false and canClearDraft: true only if no edits occurred in flight.
 */
export function evaluateInFlightSaveState(
  savedScene: ExcalidrawScene,
  currentScene: ExcalidrawScene,
): { isDirty: boolean; canClearDraft: boolean } {
  const savedSerialized = serializeSceneForComparison(savedScene);
  const currentSerialized = serializeSceneForComparison(currentScene);
  if (savedSerialized === currentSerialized) {
    return { isDirty: false, canClearDraft: true };
  }
  return { isDirty: true, canClearDraft: false };
}

/**
 * Returns the set of fileIds referenced by active, non-deleted image elements in the scene.
 */
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

/**
 * Builds a compact client-side scene with all file.dataURL properties removed,
 * preserving only metadata (id, mimeType, created, version, etc.) for active image elements.
 */
export function buildCompactClientScene(scene: ExcalidrawScene): ExcalidrawScene {
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

/**
 * Local crash-recovery draft: keep dataURL only for files not yet on the server.
 * Persisted attachments stay compact so reload hydrates from /api/attachments.
 */
export function sceneForLocalDraft(
  scene: ExcalidrawScene,
  persistedFileIds: Set<string>,
): ExcalidrawScene {
  const activeFileIds = getActiveImageFileIds(scene);
  const files: Record<string, unknown> = {};
  if (scene.files && typeof scene.files === "object") {
    for (const [fileId, fileObj] of Object.entries(scene.files as Record<string, Record<string, unknown>>)) {
      if (!fileObj || typeof fileObj !== "object") continue;
      if (!activeFileIds.has(fileId)) continue;
      files[fileId] = persistedFileIds.has(fileId) ? compactFileMetadata(fileId, fileObj) : fileObj;
    }
  }
  return {
    ...scene,
    files,
  };
}

/**
 * Convert a dataURL (base64) string into a Blob.
 */
export async function dataUrlToBlob(dataURL: string): Promise<Blob> {
  const res = await fetch(dataURL);
  return await res.blob();
}

/**
 * Uploads all newly added files in scene.files that are referenced by active image elements,
 * contain in-memory dataURL, and are not yet in persistedFileIds.
 *
 * For each new file:
 * 1. Converts dataURL to Blob.
 * 2. POST /api/documents/{docId}/attachments with FormData { file, fileId }.
 * 3. On success (200/201), adds fileId to persistedFileIds.
 * 4. If any upload fails, throws Error immediately.
 */
export async function uploadNewAttachments(
  docId: string,
  scene: ExcalidrawScene,
  persistedFileIds: Set<string>,
  options?: { fetchFn?: typeof fetch; signal?: AbortSignal },
): Promise<{ uploadedCount: number }> {
  const fetchImpl = options?.fetchFn || (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);
  let uploadedCount = 0;

  if (!scene.files || typeof scene.files !== "object") {
    return { uploadedCount: 0 };
  }

  const activeFileIds = getActiveImageFileIds(scene);

  for (const [fileId, fileObj] of Object.entries(scene.files as Record<string, Record<string, unknown>>)) {
    if (!fileObj || typeof fileObj !== "object") continue;
    if (!activeFileIds.has(fileId)) continue;
    if (persistedFileIds.has(fileId)) continue;

    const dataURL = fileObj.dataURL;
    if (typeof dataURL === "string" && dataURL.startsWith("data:")) {
      const blob = await dataUrlToBlob(dataURL);
      const formData = new FormData();
      formData.append("file", blob, fileId);
      formData.append("fileId", fileId);

      const base = typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";
      const url = new URL(`/api/documents/${encodeURIComponent(docId)}/attachments`, base);

      const res = await fetchImpl(url.toString(), {
        method: "POST",
        body: formData,
        credentials: "include",
        signal: options?.signal,
      });

      if (!res.ok) {
        throw new Error(`Failed to upload attachment ${fileId}: HTTP ${res.status}`);
      }

      persistedFileIds.add(fileId);
      uploadedCount++;
    } else {
      // File has no dataURL (already a server reference)
      persistedFileIds.add(fileId);
    }
  }

  return { uploadedCount };
}

/**
 * Rasterize the live canvas (including in-memory hydrated files) to a small PNG data URL.
 * Returns null in Node or when the scene has no elements / export fails.
 */
export async function generateThumbnailDataURL(scene: ExcalidrawScene): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!Array.isArray(scene.elements) || scene.elements.length === 0) return null;
  try {
    const { exportToBlob } = await import("@excalidraw/excalidraw");
    const blob = await exportToBlob({
      elements: scene.elements as never,
      appState: {
        exportBackground: true,
        viewBackgroundColor:
          ((scene.appState as Record<string, unknown> | undefined)?.viewBackgroundColor as string) ||
          "#ffffff",
      },
      files: (scene.files as never) || {},
      mimeType: "image/png",
      maxWidthOrHeight: 400,
    });
    if (!blob) return null;
    return blobToDataURL(blob, "image/png");
  } catch {
    return null;
  }
}

/**
 * Full pre-upload & save workflow:
 * 1. Uploads any unpersisted binary files as FormData.
 * 2. Builds a compact scene (no inline dataURL/Base64).
 * 3. On manual save or snapshot, rasterizes a PNG thumbnail from in-memory files.
 * 4. Sends compact scene JSON to /api/documents/{docId}/save (if manual) or /scene (if auto).
 */
export async function saveDocumentScene(options: SaveDocumentOptions): Promise<SaveDocumentResult> {
  const { docId, scene, persistedFileIds, isManualSave = false, snapshotDue = false, signal, fetchFn } = options;
  const fetchImpl = fetchFn || (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);

  // 1. Pre-upload new attachments before saving scene JSON
  await uploadNewAttachments(docId, scene, persistedFileIds, { fetchFn: fetchImpl, signal });

  // 2. Build compact scene with no dataURL
  const compactScene = buildCompactClientScene(scene);

  const thumbnailBase64 =
    isManualSave || snapshotDue ? await generateThumbnailDataURL(scene) : null;

  const base = typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";
  const path = isManualSave ? `/api/documents/${encodeURIComponent(docId)}/save` : `/api/documents/${encodeURIComponent(docId)}/scene`;
  const url = new URL(path, base);

  const payload = isManualSave
    ? { scene: compactScene, ...(thumbnailBase64 ? { thumbnailBase64 } : {}) }
    : { scene: compactScene, snapshot: snapshotDue, ...(thumbnailBase64 ? { thumbnailBase64 } : {}) };

  const res = await fetchImpl(url.toString(), {
    method: isManualSave ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errorData.error || `Save failed with HTTP ${res.status}`);
  }

  return (await res.json()) as SaveDocumentResult;
}
