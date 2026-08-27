import type { ExcalidrawImperativeAPI, BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ExcalidrawScene } from "./types";

export interface HydrationOptions {
  docId: string;
  shareToken?: string;
  concurrency?: number; // default: 4
  signal?: AbortSignal;
  hydratedIds?: Set<string>;
  silent?: boolean;
}

export interface HydratedFileData {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  [key: string]: unknown;
}

/** True when value is an inline data: URL Excalidraw can load as img.src. */
export function isInlineDataURL(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:") && value.includes(",");
}

/**
 * Keep only files that already have an inline dataURL.
 * Compact wire files (metadata only) must not be passed to Excalidraw initialData:
 * addFiles() refuses to replace existing file records, and a missing dataURL
 * becomes the relative URL "undefined" (e.g. /documents/undefined).
 */
export function filesWithInlineDataURL(
  files: Record<string, unknown> | null | undefined,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  if (!files || typeof files !== "object") return result;
  for (const [id, file] of Object.entries(files)) {
    if (!file || typeof file !== "object") continue;
    const dataURL = (file as Record<string, unknown>).dataURL;
    if (isInlineDataURL(dataURL)) {
      result[id] = file as Record<string, unknown>;
    }
  }
  return result;
}

/**
 * Previous failed loads may have persisted status:"error" on image elements.
 * Reset those so hydration can show a pending placeholder, then the real image.
 */
export function resetErroredImageElements(elements: unknown[]): unknown[] {
  return elements.map((el) => {
    if (!el || typeof el !== "object") return el;
    const item = el as Record<string, unknown>;
    if (item.type === "image" && item.status === "error") {
      return { ...item, status: "pending" };
    }
    return el;
  });
}

/**
 * Converts a Blob to a Base64 dataURL in browser/client memory.
 */
export async function blobToDataURL(blob: Blob, mimeType?: string): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("FileReader result is not a string"));
        }
      };
      reader.onerror = () => reject(reader.error || new Error("Failed to read blob as dataURL"));
      reader.readAsDataURL(blob);
    });
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  const mime = mimeType || blob.type || "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Download a single attachment blob from the document-scoped endpoint.
 * Decoupled from individual caller abort signals so shared fetches complete
 * for all concurrent consumers.
 */
async function fetchAttachmentBlob(
  docId: string,
  fileId: string,
  shareToken?: string,
): Promise<{ blob: Blob; mimeType: string }> {
  const base = typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";
  const url = new URL(`/api/attachments/${encodeURIComponent(fileId)}`, base);
  url.searchParams.set("docId", docId);
  if (shareToken) {
    url.searchParams.set("token", shareToken);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: Failed to fetch attachment ${fileId}`);
  }

  const blob = await res.blob();
  const mimeType = res.headers.get("content-type") || blob.type || "image/png";
  return { blob, mimeType };
}

const inFlightRequests = new Map<string, Promise<{ blob: Blob; mimeType: string }>>();

async function fetchAttachmentBlobDeduplicated(
  docId: string,
  fileId: string,
  shareToken?: string,
): Promise<{ blob: Blob; mimeType: string }> {
  const key = `${docId}:${fileId}:${shareToken || ""}`;
  let pending = inFlightRequests.get(key);
  if (!pending) {
    pending = fetchAttachmentBlob(docId, fileId, shareToken).finally(() => {
      inFlightRequests.delete(key);
    });
    inFlightRequests.set(key, pending);
  }
  return pending;
}

export interface HydrationResult {
  hydratedCount: number;
  failedCount: number;
}

/**
 * Client-only in-memory hydration engine:
 * 1. Inspects scene.files for any unhydrated files (where file.dataURL is absent).
 * 2. Fetches raw binaries with bounded concurrency (default 4).
 * 3. Converts Blobs to in-memory dataURL strings.
 * 4. Calls api.addFiles() with the array of hydrated BinaryFileData objects.
 * 5. Does NOT mutate scene.files in place.
 * 6. Handles partial failures gracefully without throwing.
 * 7. Ignores completion if signal was aborted.
 */
export async function hydrateSceneInMemory(
  scene: ExcalidrawScene | null | undefined,
  api: Pick<ExcalidrawImperativeAPI, "addFiles"> | null | undefined,
  options: HydrationOptions,
): Promise<HydrationResult> {
  if (!scene || !api) {
    return { hydratedCount: 0, failedCount: 0 };
  }

  const { docId, shareToken, concurrency = 4, signal, hydratedIds } = options;
  if (!docId) return { hydratedCount: 0, failedCount: 0 };

  const toFetch: { fileId: string; fileObj: Record<string, unknown> }[] = [];
  const queued = new Set<string>();
  const filesMap =
    scene.files && typeof scene.files === "object"
      ? (scene.files as Record<string, Record<string, unknown>>)
      : {};

  function queueFile(fileId: string, fileObj: Record<string, unknown> | undefined) {
    if (!fileId || queued.has(fileId)) return;
    const record = fileObj && typeof fileObj === "object" ? fileObj : { id: fileId };
    if (isInlineDataURL(record.dataURL)) {
      hydratedIds?.add(fileId);
      return;
    }
    // Only skip after a successful addFiles(); otherwise React Strict Mode
    // abort-and-retry would never inject binaries into Excalidraw.
    if (hydratedIds?.has(fileId)) return;
    queued.add(fileId);
    toFetch.push({ fileId, fileObj: record });
  }

  for (const [fileId, fileObj] of Object.entries(filesMap)) {
    queueFile(fileId, fileObj);
  }

  if (Array.isArray(scene.elements)) {
    for (const el of scene.elements) {
      if (!el || typeof el !== "object") continue;
      const item = el as Record<string, unknown>;
      if (item.type === "image" && !item.isDeleted && typeof item.fileId === "string") {
        queueFile(item.fileId, filesMap[item.fileId]);
      }
    }
  }

  if (toFetch.length === 0) {
    return { hydratedCount: 0, failedCount: 0 };
  }

  const hydratedList: HydratedFileData[] = [];
  let failedCount = 0;

  // Bounded worker pool concurrency
  let currentIndex = 0;
  async function worker() {
    while (currentIndex < toFetch.length) {
      if (signal?.aborted) return;
      const index = currentIndex++;
      const item = toFetch[index];
      if (!item) break;

      try {
        const { blob, mimeType } = await fetchAttachmentBlobDeduplicated(docId, item.fileId, shareToken);
        if (signal?.aborted) return;
        const dataURL = await blobToDataURL(blob, mimeType);
        if (signal?.aborted) return;

        hydratedList.push({
          ...item.fileObj,
          id: item.fileId,
          mimeType: (item.fileObj.mimeType as string) || mimeType,
          created: (item.fileObj.created as number) || Date.now(),
          dataURL,
        });
      } catch (err) {
        failedCount++;
        // Safe partial failure: log warning without crashing or unmounting canvas
        if (!signal?.aborted && !options.silent && process.env.NODE_ENV !== "test") {
          console.warn(`[client_attachments] Could not hydrate attachment ${item.fileId}:`, err);
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, toFetch.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (signal?.aborted) {
    return { hydratedCount: 0, failedCount };
  }

  if (hydratedList.length > 0) {
    // Add completed files to Excalidraw canvas runtime
    api.addFiles(hydratedList as unknown as BinaryFileData[]);
    for (const file of hydratedList) {
      hydratedIds?.add(file.id);
    }
  }

  return { hydratedCount: hydratedList.length, failedCount };
}
