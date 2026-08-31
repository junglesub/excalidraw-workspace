import type { ExcalidrawScene } from "./types";
import { blobToDataURL } from "./client_attachments";
import {
  getActiveImageFileIds as sharedGetActiveImageFileIds,
  buildCompactScene as sharedBuildCompactScene,
  serializeForComparison as sharedSerializeForComparison,
} from "./scene_normalize";

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
  alreadySaved?: boolean;
  updatedAt?: string;
  versions?: unknown[];
  snapshot?: unknown;
}

export function getManualSaveStatus(result: SaveDocumentResult): string {
  if (result.alreadySaved) return "Already saved";
  if (result.snapshotCreated) return "Snapshot saved";
  return "Saved";
}

function compactFileMetadata(fileId: string, fileObj: Record<string, unknown>): Record<string, unknown> {
  return {
    id: fileId,
    mimeType: (fileObj.mimeType as string) || "image/png",
    created: (fileObj.created as number) || 0,
    ...(fileObj.version ? { version: fileObj.version } : {}),
  };
}

export function serializeSceneForComparison(s: ExcalidrawScene): string {
  return sharedSerializeForComparison(s);
}

export interface LocalDraftEnvelope {
  scene: ExcalidrawScene;
  updatedAt: number;
}

export interface RecoverySceneSummary {
  updatedAt: number | string;
  elementCount: number;
  imageCount: number;
}

export type DraftLoadDecision =
  | { kind: "server" }
  | { kind: "equal" }
  | { kind: "conflict"; draft: LocalDraftEnvelope }
  | { kind: "malformed" };

export function localDraftStorageKey(userId: string, docId: string): string {
  return `excalidraw_draft_${userId}_${docId}`;
}

export function decideDraftAtLoad(
  raw: string | null,
  serverScene: ExcalidrawScene,
): DraftLoadDecision {
  if (raw === null) return { kind: "server" };
  try {
    const parsed = JSON.parse(raw) as Partial<LocalDraftEnvelope>;
    if (
      !parsed.scene ||
      typeof parsed.scene !== "object" ||
      !Array.isArray(parsed.scene.elements) ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return { kind: "malformed" };
    }
    const draft = parsed as LocalDraftEnvelope;
    return serializeSceneForComparison(draft.scene) === serializeSceneForComparison(serverScene)
      ? { kind: "equal" }
      : { kind: "conflict", draft };
  } catch {
    return { kind: "malformed" };
  }
}

export function decideDraftForAccess(
  canEdit: boolean,
  readDraft: () => string | null,
  serverScene: ExcalidrawScene,
): DraftLoadDecision {
  return canEdit ? decideDraftAtLoad(readDraft(), serverScene) : { kind: "server" };
}

export function summarizeRecoveryScene(
  scene: ExcalidrawScene,
  updatedAt: number | string,
): RecoverySceneSummary {
  return {
    updatedAt,
    elementCount: Array.isArray(scene.elements) ? scene.elements.length : 0,
    imageCount: getActiveImageFileIds(scene).size,
  };
}

export function sceneMatchesLastSaved(
  scene: ExcalidrawScene,
  lastSavedSerialized: string,
): boolean {
  return serializeSceneForComparison(scene) === lastSavedSerialized;
}

export interface ResolveClientRecoveryOptions {
  docId: string;
  choice: "client" | "server";
  preserveDiscarded: boolean;
  expectedServerUpdatedAt: string;
  draft: LocalDraftEnvelope;
  persistedFileIds: Set<string>;
  fetchFn?: typeof fetch;
}

export type ResolveClientRecoveryResult =
  | {
      ok: true;
      choice: "client" | "server";
      snapshotCreated: boolean;
      updatedAt: string;
    }
  | {
      ok: false;
      code: "SERVER_VERSION_CHANGED";
      serverScene: ExcalidrawScene;
      serverUpdatedAt: string;
    };

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

export function getActiveImageFileIds(scene: ExcalidrawScene): Set<string> {
  return sharedGetActiveImageFileIds(scene);
}

export function buildCompactClientScene(scene: ExcalidrawScene): ExcalidrawScene {
  return sharedBuildCompactScene(scene);
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

export async function resolveClientRecovery(
  options: ResolveClientRecoveryOptions,
): Promise<ResolveClientRecoveryResult> {
  const fetchImpl =
    options.fetchFn || (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);
  const mustKeepClient = options.choice === "client" || options.preserveDiscarded;
  if (mustKeepClient) {
    await uploadNewAttachments(options.docId, options.draft.scene, options.persistedFileIds, {
      fetchFn: fetchImpl,
    });
  }
  const compactScene = buildCompactClientScene(options.draft.scene);
  const clientThumbnailBase64 =
    options.choice === "server" && options.preserveDiscarded
      ? await generateThumbnailDataURL(options.draft.scene)
      : null;
  const base = typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";
  const path = `/api/documents/${encodeURIComponent(options.docId)}/recovery`;
  const url = new URL(path, base);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      choice: options.choice,
      preserveDiscarded: options.preserveDiscarded,
      expectedServerUpdatedAt: options.expectedServerUpdatedAt,
      clientScene: compactScene,
      clientUpdatedAt: options.draft.updatedAt,
      ...(clientThumbnailBase64 ? { clientThumbnailBase64 } : {}),
    }),
  });
  const data = (await response.json()) as ResolveClientRecoveryResult & { error?: string };
  if (response.status === 409 && !data.ok && data.code === "SERVER_VERSION_CHANGED") {
    return data;
  }
  if (!response.ok) throw new Error(data.error || `Recovery failed with HTTP ${response.status}`);
  return data;
}
