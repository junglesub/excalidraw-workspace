import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCompactClientScene,
  uploadNewAttachments,
  saveDocumentScene,
  evaluateInFlightSaveState,
  getActiveImageFileIds,
  serializeSceneForComparison,
  sceneForLocalDraft,
  decideDraftForAccess,
  decideDraftAtLoad,
  localDraftStorageKey,
  summarizeRecoveryScene,
  resolveClientRecovery,
  sceneMatchesLastSaved,
  getManualSaveStatus,
} from "@/lib/client_save";
import { emptyScene } from "@/lib/types";
import type { ExcalidrawScene } from "@/lib/types";

describe("Client Save Pipeline", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should strip dataURL from scene.files in buildCompactClientScene", () => {
    const sceneWithDataUrl: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "img1", type: "image", fileId: "f1" }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {
        f1: {
          id: "f1",
          mimeType: "image/png",
          created: 123456,
          dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          version: 1,
        },
      },
    };

    const compact = buildCompactClientScene(sceneWithDataUrl);
    const fileF1 = compact.files?.f1 as any;
    expect(fileF1).toBeDefined();
    expect(fileF1.id).toBe("f1");
    expect(fileF1.mimeType).toBe("image/png");
    expect(fileF1.dataURL).toBeUndefined();
  });

  it("should upload newly added files with dataURL as FormData before saving scene", async () => {
    const uploadedFormData: { fileId: string; fileName: string; size: number }[] = [];

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/documents/doc_1/attachments")) {
        const body = init?.body as FormData;
        const file = body.get("file") as File | Blob;
        const fileId = body.get("fileId") as string;
        uploadedFormData.push({
          fileId,
          fileName: (file as any).name || "file",
          size: file.size,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const dataURL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "img1", type: "image", fileId: "new_file_1" }],
      appState: {},
      files: {
        already_saved_file: {
          id: "already_saved_file",
          mimeType: "image/png",
          created: 1,
        },
        new_file_1: {
          id: "new_file_1",
          mimeType: "image/png",
          dataURL,
          created: 2,
        },
      },
    };

    const persistedFileIds = new Set<string>(["already_saved_file"]);

    const res = await uploadNewAttachments("doc_1", scene, persistedFileIds);

    expect(res.uploadedCount).toBe(1);
    expect(uploadedFormData).toHaveLength(1);
    expect(uploadedFormData[0].fileId).toBe("new_file_1");
    expect(persistedFileIds.has("new_file_1")).toBe(true);
  });

  it("should fail save pipeline and preserve local dirty state when attachment upload fails", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/documents/doc_fail/attachments")) {
        return new Response(JSON.stringify({ error: "Upload rejected" }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "img1", type: "image", fileId: "bad_file" }],
      appState: {},
      files: {
        bad_file: {
          id: "bad_file",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AAAA",
          created: 1,
        },
      },
    };

    const persistedFileIds = new Set<string>();

    await expect(
      saveDocumentScene({
        docId: "doc_fail",
        scene,
        persistedFileIds,
        isManualSave: false,
      }),
    ).rejects.toThrow("Failed to upload attachment bad_file");

    // File must not be marked persisted
    expect(persistedFileIds.has("bad_file")).toBe(false);
  });

  it("should send compact scene JSON without thumbnailBase64 when executing saveDocumentScene", async () => {
    let savedPayload: any = null;
    let savedUrl: string = "";

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/attachments")) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      if (urlStr.includes("/scene") || urlStr.includes("/save")) {
        savedUrl = urlStr;
        savedPayload = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ ok: true, snapshotCreated: false, updatedAt: new Date().toISOString() }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const dataURL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "img1", type: "image", fileId: "file_ok" }],
      appState: { viewBackgroundColor: "#fafafa" },
      files: {
        file_ok: {
          id: "file_ok",
          mimeType: "image/png",
          dataURL,
          created: 100,
        },
      },
    };

    const persistedFileIds = new Set<string>();

    await saveDocumentScene({
      docId: "doc_saved",
      scene,
      persistedFileIds,
      isManualSave: true,
    });

    expect(savedUrl).toContain("/api/documents/doc_saved/save");
    expect(savedPayload).toBeDefined();
    expect(savedPayload.scene).toBeDefined();
    // Node has no window, so live canvas rasterization is skipped; scene.files stay compact.
    expect(savedPayload.thumbnailBase64).toBeUndefined();
    expect(savedPayload.scene.files.file_ok.dataURL).toBeUndefined();
    expect(persistedFileIds.has("file_ok")).toBe(true);
  });

  it("should only upload active, non-deleted image fileIds and ignore stale or deleted scene.files entries", async () => {
    const uploadedFileIds: string[] = [];

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/attachments")) {
        const body = init?.body as FormData;
        const fileId = body.get("fileId") as string;
        uploadedFileIds.push(fileId);
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const dataURL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "img_active", type: "image", fileId: "active_img_1", isDeleted: false },
        { id: "img_deleted", type: "image", fileId: "deleted_img_2", isDeleted: true },
      ],
      appState: {},
      files: {
        active_img_1: { id: "active_img_1", mimeType: "image/png", dataURL, created: 1 },
        deleted_img_2: { id: "deleted_img_2", mimeType: "image/png", dataURL, created: 2 },
        unreferenced_stale_3: { id: "unreferenced_stale_3", mimeType: "image/png", dataURL, created: 3 },
      },
    };

    const persistedFileIds = new Set<string>();

    const res = await uploadNewAttachments("doc_filter", scene, persistedFileIds);

    expect(res.uploadedCount).toBe(1);
    expect(uploadedFileIds).toEqual(["active_img_1"]);
    expect(persistedFileIds.has("active_img_1")).toBe(true);
    expect(persistedFileIds.has("deleted_img_2")).toBe(false);
    expect(persistedFileIds.has("unreferenced_stale_3")).toBe(false);

    const compact = buildCompactClientScene(scene);
    expect(Object.keys(compact.files || {})).toEqual(["active_img_1"]);
  });

  it("should guard dirty state and draft persistence when scene is edited during in-flight save", () => {
    const savedScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "1", type: "rectangle" }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };

    // Case 1: No edits during save -> clean state, safe to clear draft
    const noEditState = evaluateInFlightSaveState(savedScene, savedScene);
    expect(noEditState.isDirty).toBe(false);
    expect(noEditState.canClearDraft).toBe(true);

    // Case 2: User drew a new rectangle while save was in flight -> dirty state retained, draft kept
    const modifiedScene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "1", type: "rectangle" }, { id: "2", type: "ellipse" }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };

    const inFlightEditState = evaluateInFlightSaveState(savedScene, modifiedScene);
    expect(inFlightEditState.isDirty).toBe(true);
    expect(inFlightEditState.canClearDraft).toBe(false);
  });

  it("should ignore in-memory dataURL when comparing dirty state so hydration is not an edit", () => {
    const compact: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "img1", type: "image", fileId: "f1", isDeleted: false }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {
        f1: { id: "f1", mimeType: "image/png", created: 100 },
      },
    };
    const hydrated: ExcalidrawScene = {
      ...compact,
      files: {
        f1: {
          id: "f1",
          mimeType: "image/png",
          created: 100,
          dataURL: "data:image/png;base64,AAA=",
        },
      },
    };

    expect(serializeSceneForComparison(compact)).toBe(serializeSceneForComparison(hydrated));
    const state = evaluateInFlightSaveState(compact, hydrated);
    expect(state.isDirty).toBe(false);
    expect(state.canClearDraft).toBe(true);
  });

  it("should keep dataURL in local drafts only for files not yet persisted", () => {
    const dataURL = "data:image/png;base64,AAA=";
    const scene: ExcalidrawScene = {
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "img_old", type: "image", fileId: "persisted_1", isDeleted: false },
        { id: "img_new", type: "image", fileId: "new_1", isDeleted: false },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {
        persisted_1: { id: "persisted_1", mimeType: "image/png", created: 1, dataURL },
        new_1: { id: "new_1", mimeType: "image/png", created: 2, dataURL },
      },
    };

    const draft = sceneForLocalDraft(scene, new Set(["persisted_1"]));
    expect((draft.files.persisted_1 as { dataURL?: string }).dataURL).toBeUndefined();
    expect((draft.files.new_1 as { dataURL?: string }).dataURL).toBe(dataURL);
  });

  it("uses user- and document-scoped local draft keys", () => {
    expect(localDraftStorageKey("user-a", "doc-1")).toBe("excalidraw_draft_user-a_doc-1");
    expect(localDraftStorageKey("user-a", "doc-1")).not.toBe(
      localDraftStorageKey("user-b", "doc-1"),
    );
  });

  it("does not read draft storage without write access", () => {
    const readDraft = vi.fn(() => JSON.stringify({ scene: emptyScene(), updatedAt: 1 }));
    expect(decideDraftForAccess(false, readDraft, emptyScene())).toEqual({ kind: "server" });
    expect(readDraft).not.toHaveBeenCalled();
  });

  it("detects any normalized mismatch regardless of timestamps and accepts an empty draft", () => {
    const server = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
    const emptyDraft = JSON.stringify({ scene: emptyScene(), updatedAt: 1 });

    const decision = decideDraftAtLoad(emptyDraft, server);
    expect(decision.kind).toBe("conflict");
  });

  it("treats hydration-only dataURL differences and file insertion order as equal", () => {
    const server: ExcalidrawScene = {
      ...emptyScene(),
      elements: [
        { id: "a", type: "image", fileId: "f-a", isDeleted: false },
        { id: "b", type: "image", fileId: "f-b", isDeleted: false },
      ],
      files: {
        "f-a": { id: "f-a", mimeType: "image/png", created: 1 },
        "f-b": { id: "f-b", mimeType: "image/png", created: 2 },
      },
    };
    const draft = {
      ...server,
      files: {
        "f-b": { id: "f-b", mimeType: "image/png", created: 2, dataURL: "data:image/png;base64,QQ==" },
        "f-a": { id: "f-a", mimeType: "image/png", created: 1, dataURL: "data:image/png;base64,QQ==" },
      },
    };

    expect(decideDraftAtLoad(JSON.stringify({ scene: draft, updatedAt: 999 }), server)).toEqual({
      kind: "equal",
    });
  });

  it("preserves malformed and legacy values as non-recoverable decisions", () => {
    expect(decideDraftAtLoad("{broken", emptyScene())).toEqual({ kind: "malformed" });
    expect(decideDraftAtLoad(JSON.stringify(emptyScene()), emptyScene())).toEqual({ kind: "malformed" });
  });

  it("summarizes total elements and active images for the conflict dialog", () => {
    const scene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [
        { id: "rect", type: "rectangle" },
        { id: "live", type: "image", fileId: "live-file", isDeleted: false },
        { id: "deleted", type: "image", fileId: "deleted-file", isDeleted: true },
      ],
    };
    expect(summarizeRecoveryScene(scene, 123)).toEqual({
      updatedAt: 123,
      elementCount: 3,
      imageCount: 1,
    });
  });

  it("uploads a new draft image before asking the server to snapshot the client draft", async () => {
    const calls: string[] = [];
    const dataURL = "data:image/png;base64,QQ==";
    const scene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "image", type: "image", fileId: "new-file", isDeleted: false }],
      files: { "new-file": { id: "new-file", mimeType: "image/png", dataURL, created: 1 } },
    };
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).includes("/attachments")) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(
        JSON.stringify({ ok: true, choice: "server", snapshotCreated: true, updatedAt: "server-time" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await resolveClientRecovery({
      docId: "doc-1",
      choice: "server",
      preserveDiscarded: true,
      expectedServerUpdatedAt: "initial-time",
      draft: { scene, updatedAt: 123 },
      persistedFileIds: new Set(),
      fetchFn,
    });

    expect(calls[0]).toContain("/attachments");
    expect(calls[1]).toContain("/recovery");
  });

  it("does not upload discarded files when choosing server without preservation", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, choice: "server", snapshotCreated: false, updatedAt: "server-time" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    await resolveClientRecovery({
      docId: "doc-1",
      choice: "server",
      preserveDiscarded: false,
      expectedServerUpdatedAt: "initial-time",
      draft: {
        scene: {
          ...emptyScene(),
          elements: [{ id: "image", type: "image", fileId: "new-file", isDeleted: false }],
          files: {
            "new-file": {
              id: "new-file",
              mimeType: "image/png",
              dataURL: "data:image/png;base64,QQ==",
              created: 1,
            },
          },
        },
        updatedAt: 123,
      },
      persistedFileIds: new Set(),
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("/recovery");
  });

  it("returns a structured optimistic conflict instead of deleting client state", async () => {
    const latest = { ...emptyScene(), elements: [{ id: "latest", type: "diamond" }] };
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          code: "SERVER_VERSION_CHANGED",
          serverScene: latest,
          serverUpdatedAt: "latest-time",
        }),
        { status: 409 },
      ),
    ) as unknown as typeof fetch;
    await expect(
      resolveClientRecovery({
        docId: "doc-1",
        choice: "client",
        preserveDiscarded: false,
        expectedServerUpdatedAt: "initial-time",
        draft: { scene: emptyScene(), updatedAt: 123 },
        persistedFileIds: new Set(),
        fetchFn,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "SERVER_VERSION_CHANGED",
      serverScene: latest,
      serverUpdatedAt: "latest-time",
    });
  });

  it("throws the server error when recovery fails", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: "snapshot failed" }), { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      resolveClientRecovery({
        docId: "doc-1",
        choice: "server",
        preserveDiscarded: false,
        expectedServerUpdatedAt: "initial-time",
        draft: { scene: emptyScene(), updatedAt: 123 },
        persistedFileIds: new Set(),
        fetchFn,
      }),
    ).rejects.toThrow("snapshot failed");
  });

  it("recognizes undo back to the last saved scene as clean", () => {
    const saved = { ...emptyScene(), elements: [{ id: "saved", type: "rectangle" }] };
    expect(sceneMatchesLastSaved(saved, serializeSceneForComparison(saved))).toBe(true);
  });

  it("decides client-visible manual save status from server result", () => {
    expect(getManualSaveStatus({ ok: true, alreadySaved: true, snapshotCreated: false })).toBe("Already saved");
    expect(getManualSaveStatus({ ok: true, alreadySaved: false, snapshotCreated: true })).toBe("Snapshot saved");
    expect(getManualSaveStatus({ ok: true, snapshotCreated: false })).toBe("Saved");
    expect(getManualSaveStatus({ ok: true, alreadySaved: false, snapshotCreated: false })).toBe("Saved");
  });
});
