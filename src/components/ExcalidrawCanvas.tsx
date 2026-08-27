"use client";

import dynamic from "next/dynamic";
import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawScene } from "@/lib/types";
import {
  filesWithInlineDataURL,
  hydrateSceneInMemory,
  resetErroredImageElements,
} from "@/lib/client_attachments";

const BaseExcalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  { ssr: false },
);

interface Props {
  initialScene: ExcalidrawScene;
  readOnly: boolean;
  onSceneChange: (scene: ExcalidrawScene) => void;
  theme?: "light" | "dark";
  docId?: string;
  shareToken?: string;
}

/**
 * Canvas wrapper around the official @excalidraw/excalidraw package.
 * Handles the editor (editable) or read-only viewer (navigation only) modes,
 * and hydrates binary attachments in client memory on load.
 */
export default function ExcalidrawCanvas({
  initialScene,
  readOnly,
  onSceneChange,
  theme = "light",
  docId,
  shareToken,
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const hydratedIdsRef = useRef<Set<string>>(new Set());

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const seedFiles = (initialScene.files as BinaryFiles) || {};
      onSceneChange({
        type: "excalidraw",
        version: 2,
        elements: elements as unknown[],
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
        },
        // Compact metadata stays until addFiles lands, so autosave cannot wipe fileIds.
        files: { ...seedFiles, ...files },
      } as ExcalidrawScene);
    },
    [onSceneChange, initialScene.files],
  );

  const initialData = useMemo<ExcalidrawInitialDataState>(() => {
    const rawElements = Array.isArray(initialScene.elements) ? initialScene.elements : [];
    return {
      elements: resetErroredImageElements(rawElements) as readonly ExcalidrawElement[],
      appState:
        initialScene.appState && typeof initialScene.appState === "object"
          ? (initialScene.appState as unknown as Partial<AppState>)
          : {},
      files: filesWithInlineDataURL(initialScene.files as Record<string, unknown>) as BinaryFiles,
    };
  }, [initialScene]);

  const uiOptions = useMemo(
    () => ({
      canvasActions: {
        loadScene: false,
        export: (readOnly ? false : { saveFileToDisk: true }) as false | { saveFileToDisk?: boolean },
      },
    }),
    [readOnly],
  );

  const [apiInstance, setApiInstance] = useState<ExcalidrawImperativeAPI | null>(null);
  const [failedHydrationCount, setFailedHydrationCount] = useState<number>(0);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setApiInstance(api);
  }, []);

  useEffect(() => {
    if (!apiInstance || !docId) return;
    const controller = new AbortController();
    hydrateSceneInMemory(initialScene, apiInstance, {
      docId,
      shareToken,
      signal: controller.signal,
      hydratedIds: hydratedIdsRef.current,
    })
      .then((res) => {
        if (!controller.signal.aborted && res && res.failedCount > 0) {
          setFailedHydrationCount(res.failedCount);
        }
      })
      .catch(() => {
        // Safe catch to ensure canvas never crashes
      });
    return () => {
      controller.abort();
    };
  }, [apiInstance, docId, initialScene, shareToken]);

  return (
    <div className="relative w-full h-full">
      {failedHydrationCount > 0 && (
        <div className="absolute top-3 right-3 z-50 bg-amber-600 text-white text-xs px-3 py-1.5 rounded shadow-md flex items-center gap-2 pointer-events-auto">
          <span>{failedHydrationCount} image(s) failed to load.</span>
          <button
            type="button"
            onClick={() => setFailedHydrationCount(0)}
            className="text-white hover:text-amber-200 font-bold ml-1"
          >
            ✕
          </button>
        </div>
      )}
      <BaseExcalidraw
        excalidrawAPI={handleApi}
        initialData={initialData}
        onChange={handleChange}
        viewModeEnabled={readOnly}
        UIOptions={uiOptions}
        theme={theme}
        autoFocus={!readOnly}
      />
    </div>
  );
}