"use client";

import dynamic from "next/dynamic";
import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import { useCallback, useMemo, useRef } from "react";
import type { ExcalidrawScene } from "@/lib/types";

// Styles are bundled by the package; no separate CSS import needed for v0.17.

const BaseExcalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  { ssr: false },
);

interface Props {
  initialScene: ExcalidrawScene;
  readOnly: boolean;
  onSceneChange: (scene: ExcalidrawScene) => void;
  theme?: "light" | "dark";
}

/**
 * Canvas wrapper around the official @excalidraw/excalidraw package.
 * Handles the editor (editable) or read-only viewer (navigation only) modes.
 */
export default function ExcalidrawCanvas({
  initialScene,
  readOnly,
  onSceneChange,
  theme = "light",
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      onSceneChange({
        type: "excalidraw",
        version: 2,
        elements: elements as unknown[],
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
        },
        files,
      } as ExcalidrawScene);
    },
    [onSceneChange],
  );

  const initialData = useMemo<ExcalidrawInitialDataState>(() => {
    return {
      elements: (Array.isArray(initialScene.elements)
        ? initialScene.elements
        : []) as readonly ExcalidrawElement[],
      appState:
        initialScene.appState && typeof initialScene.appState === "object"
          ? (initialScene.appState as AppState)
          : {},
      files: (initialScene.files as BinaryFiles) || {},
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

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  return (
    <div className="relative w-full h-full">
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