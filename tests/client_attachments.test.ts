import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hydrateSceneInMemory,
  blobToDataURL,
  filesWithInlineDataURL,
  resetErroredImageElements,
} from "@/lib/client_attachments";
import type { ExcalidrawScene } from "@/lib/types";

describe("Client Attachment Hydration Engine", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should convert a blob to in-memory dataURL", async () => {
    const rawString = "test image binary content";
    const blob = new Blob([rawString], { type: "image/png" });
    const dataURL = await blobToDataURL(blob, "image/png");
    expect(dataURL.startsWith("data:image/png;base64,")).toBe(true);
    const base64Part = dataURL.split("base64,")[1];
    expect(Buffer.from(base64Part, "base64").toString("utf-8")).toBe(rawString);
  });

  it("should fetch attachments with docId and credentials for authenticated requests and call api.addFiles", async () => {
    const fetchedUrls: string[] = [];
    const fetchOptions: RequestInit[] = [];

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchedUrls.push(String(url));
      if (init) fetchOptions.push(init);
      const blob = new Blob(["image-bytes-1"], { type: "image/png" });
      return new Response(blob, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi = {
      addFiles: vi.fn(),
    };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "el1", type: "image", fileId: "file_123" }],
      appState: {},
      files: {
        file_123: { id: "file_123", mimeType: "image/png", created: 1000 },
      },
    };

    const hydratedIds = new Set<string>();
    await hydrateSceneInMemory(scene, mockApi as any, {
      docId: "doc_abc",
      hydratedIds,
    });

    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("/api/attachments/file_123?docId=doc_abc");
    expect(fetchOptions[0]?.credentials).toBe("include");

    expect(mockApi.addFiles).toHaveBeenCalledTimes(1);
    const addedFiles = mockApi.addFiles.mock.calls[0][0];
    expect(addedFiles).toHaveLength(1);
    expect(addedFiles[0].id).toBe("file_123");
    expect(addedFiles[0].mimeType).toBe("image/png");
    expect(addedFiles[0].dataURL).toBeDefined();
    expect(addedFiles[0].dataURL.startsWith("data:image/png;base64,")).toBe(true);

    // Ensure hydratedIds set is updated
    expect(hydratedIds.has("file_123")).toBe(true);

    // Verify scene object was not mutated with dataURL
    expect((scene.files?.file_123 as any)?.dataURL).toBeUndefined();
  });

  it("should append share token for public share links", async () => {
    const fetchedUrls: string[] = [];

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      fetchedUrls.push(String(url));
      const blob = new Blob(["share-image-bytes"], { type: "image/jpeg" });
      return new Response(blob, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;

    const mockApi = {
      addFiles: vi.fn(),
    };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "el1", type: "image", fileId: "share_img_1" }],
      appState: {},
      files: {
        share_img_1: { id: "share_img_1", mimeType: "image/jpeg", created: 2000 },
      },
    };

    await hydrateSceneInMemory(scene, mockApi as any, {
      docId: "doc_xyz",
      shareToken: "token_secret_123",
    });

    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("/api/attachments/share_img_1?docId=doc_xyz&token=token_secret_123");
    expect(mockApi.addFiles).toHaveBeenCalledTimes(1);
  });

  it("should handle partial failures gracefully without throwing and add successful files", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("file_missing")) {
        return new Response("Not found", { status: 404 });
      }
      if (urlStr.includes("file_network_err")) {
        throw new Error("Network offline");
      }
      return new Response(new Blob(["good-image"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi = {
      addFiles: vi.fn(),
    };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {
        file_good: { id: "file_good", mimeType: "image/png", created: 1 },
        file_missing: { id: "file_missing", mimeType: "image/png", created: 2 },
        file_network_err: { id: "file_network_err", mimeType: "image/png", created: 3 },
      },
    };

    // Should not throw error
    await expect(
      hydrateSceneInMemory(scene, mockApi as any, { docId: "doc_test" }),
    ).resolves.not.toThrow();

    expect(mockApi.addFiles).toHaveBeenCalledTimes(1);
    const added = mockApi.addFiles.mock.calls[0][0];
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe("file_good");
  });

  it("should deduplicate files already in hydratedIds or with dataURL", async () => {
    const fetchedUrls: string[] = [];

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      fetchedUrls.push(String(url));
      return new Response(new Blob(["data"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi = {
      addFiles: vi.fn(),
    };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {
        file_already_hydrated: { id: "file_already_hydrated", mimeType: "image/png", created: 1 },
        file_has_dataurl: {
          id: "file_has_dataurl",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AAA=",
          created: 2,
        },
        file_new: { id: "file_new", mimeType: "image/png", created: 3 },
      },
    };

    const hydratedIds = new Set<string>(["file_already_hydrated"]);

    await hydrateSceneInMemory(scene, mockApi as any, {
      docId: "doc_test",
      hydratedIds,
    });

    // Only file_new should have triggered a fetch
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("file_new");
    expect(mockApi.addFiles).toHaveBeenCalledTimes(1);
    expect(mockApi.addFiles.mock.calls[0][0][0].id).toBe("file_new");
  });

  it("should limit maximum concurrent downloads to 4", async () => {
    let activeRequests = 0;
    let maxObservedConcurrency = 0;

    globalThis.fetch = vi.fn(async () => {
      activeRequests++;
      if (activeRequests > maxObservedConcurrency) {
        maxObservedConcurrency = activeRequests;
      }
      // Artificial delay to observe concurrent pool
      await new Promise((r) => setTimeout(r, 20));
      activeRequests--;
      return new Response(new Blob(["concurrent-bytes"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi = {
      addFiles: vi.fn(),
    };

    const filesMap: Record<string, { id: string; mimeType: string; created: number }> = {};
    for (let i = 1; i <= 10; i++) {
      filesMap[`file_${i}`] = { id: `file_${i}`, mimeType: "image/png", created: i };
    }

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: filesMap,
    };

    await hydrateSceneInMemory(scene, mockApi as any, {
      docId: "doc_concurrency",
      concurrency: 4,
    });

    expect(maxObservedConcurrency).toBeLessThanOrEqual(4);
    expect(mockApi.addFiles).toHaveBeenCalledTimes(1);
    expect(mockApi.addFiles.mock.calls[0][0]).toHaveLength(10);
  });

  it("should not call api.addFiles if aborted before completion", async () => {
    globalThis.fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response(new Blob(["aborted-bytes"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi = {
      addFiles: vi.fn(),
    };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {
        file_abort: { id: "file_abort", mimeType: "image/png", created: 1 },
      },
    };

    const controller = new AbortController();
    const promise = hydrateSceneInMemory(scene, mockApi as any, {
      docId: "doc_abort",
      signal: controller.signal,
    });

    // Abort immediately
    controller.abort();
    await promise;

    expect(mockApi.addFiles).not.toHaveBeenCalled();
  });

  it("should deduplicate in-flight hydration requests and avoid duplicate network calls when invoked concurrently", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(new Blob(["concurrent-dedupe"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi1 = { addFiles: vi.fn() };
    const mockApi2 = { addFiles: vi.fn() };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {
        file_shared: { id: "file_shared", mimeType: "image/png", created: 1 },
      },
    };

    const hydratedIds = new Set<string>();

    // Run two simultaneous hydration calls for the same doc and file
    await Promise.all([
      hydrateSceneInMemory(scene, mockApi1 as any, { docId: "doc_shared", hydratedIds }),
      hydrateSceneInMemory(scene, mockApi2 as any, { docId: "doc_shared", hydratedIds }),
    ]);

    expect(fetchCount).toBe(1);
    expect(hydratedIds.has("file_shared")).toBe(true);
  });

  it("should not abort shared in-flight fetch when first caller aborts, allowing second caller to succeed", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(new Blob(["shared-bytes"], { type: "image/png" }), {
              status: 200,
              headers: { "Content-Type": "image/png" },
            }),
          );
        }, 50);

        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("AbortError"));
          });
        }
      });
    }) as unknown as typeof fetch;

    const mockApi1 = { addFiles: vi.fn() };
    const mockApi2 = { addFiles: vi.fn() };

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {
        file_race: { id: "file_race", mimeType: "image/png", created: 10 },
      },
    };

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const hydratedIds = new Set<string>();

    // Start caller 1 and caller 2 concurrently
    const p1 = hydrateSceneInMemory(scene, mockApi1 as any, {
      docId: "doc_race",
      signal: controller1.signal,
      hydratedIds,
    });
    const p2 = hydrateSceneInMemory(scene, mockApi2 as any, {
      docId: "doc_race",
      signal: controller2.signal,
      hydratedIds,
    });

    // Abort caller 1 after a short delay before fetch completes
    setTimeout(() => {
      controller1.abort();
    }, 10);

    await Promise.all([p1, p2]);

    // Exactly 1 network request
    expect(fetchCount).toBe(1);

    // Caller 1 was aborted, so mockApi1.addFiles must NOT be called
    expect(mockApi1.addFiles).not.toHaveBeenCalled();

    // Caller 2 was NOT aborted, so mockApi2.addFiles must be called with the hydrated file
    expect(mockApi2.addFiles).toHaveBeenCalledTimes(1);
    const added2 = mockApi2.addFiles.mock.calls[0][0];
    expect(added2).toHaveLength(1);
    expect(added2[0].id).toBe("file_race");
  });

  it("should omit compact files without dataURL so Excalidraw never loads /documents/undefined", () => {
    const files = {
      compact: { id: "compact", mimeType: "image/png", created: 1 },
      emptyUrl: { id: "emptyUrl", mimeType: "image/png", dataURL: undefined, created: 2 },
      relative: { id: "relative", mimeType: "image/png", dataURL: "/api/attachments/x", created: 3 },
      inline: {
        id: "inline",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAA=",
        created: 4,
      },
    };

    const kept = filesWithInlineDataURL(files);
    expect(Object.keys(kept)).toEqual(["inline"]);
    expect(filesWithInlineDataURL(null)).toEqual({});
    expect(filesWithInlineDataURL(undefined)).toEqual({});
  });

  it("should reset persisted image status:error so hydration can recover", () => {
    const elements = [
      { id: "img1", type: "image", fileId: "f1", status: "error" },
      { id: "rect", type: "rectangle" },
      { id: "img2", type: "image", fileId: "f2", status: "saved" },
    ];
    const reset = resetErroredImageElements(elements);
    expect(reset[0]).toMatchObject({ id: "img1", status: "pending" });
    expect(reset[1]).toEqual(elements[1]);
    expect(reset[2]).toEqual(elements[2]);
  });

  it("should still addFiles on retry after an aborted hydration that shared hydratedIds", async () => {
    globalThis.fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return new Response(new Blob(["retry-bytes"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "el1", type: "image", fileId: "file_retry" }],
      appState: {},
      files: {
        file_retry: { id: "file_retry", mimeType: "image/png", created: 1 },
      },
    };

    const hydratedIds = new Set<string>();
    const abortedApi = { addFiles: vi.fn() };
    const retryApi = { addFiles: vi.fn() };

    const controller = new AbortController();
    const first = hydrateSceneInMemory(scene, abortedApi as any, {
      docId: "doc_retry",
      signal: controller.signal,
      hydratedIds,
    });
    controller.abort();
    await first;

    expect(abortedApi.addFiles).not.toHaveBeenCalled();
    expect(hydratedIds.has("file_retry")).toBe(false);

    await hydrateSceneInMemory(scene, retryApi as any, {
      docId: "doc_retry",
      hydratedIds,
    });

    expect(retryApi.addFiles).toHaveBeenCalledTimes(1);
    expect(retryApi.addFiles.mock.calls[0][0][0].id).toBe("file_retry");
    expect(hydratedIds.has("file_retry")).toBe(true);
  });

  it("should fetch fileIds referenced by image elements even if missing from scene.files", async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      fetchedUrls.push(String(url));
      return new Response(new Blob(["orphan-bytes"], { type: "image/png" }), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const mockApi = { addFiles: vi.fn() };
    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "el1", type: "image", fileId: "orphan_file", isDeleted: false }],
      appState: {},
      files: {},
    };

    await hydrateSceneInMemory(scene, mockApi as any, { docId: "doc_orphan" });

    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("/api/attachments/orphan_file?docId=doc_orphan");
    expect(mockApi.addFiles).toHaveBeenCalledTimes(1);
    expect(mockApi.addFiles.mock.calls[0][0][0].id).toBe("orphan_file");
  });
});
