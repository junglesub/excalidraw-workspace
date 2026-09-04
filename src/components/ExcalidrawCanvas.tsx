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
import type { DeckAspectRatio, ExcalidrawScene } from "@/lib/types";
import { recordingFrameFitOptions, recordingFrameForAspectRatio, recordingFrameSkeleton } from "@/lib/recording_frame";
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
  recordingFrameAspectRatio?: DeckAspectRatio;
  recordingFrameResetNonce?: number;
  toolbarOrientation?: "horizontal" | "vertical";
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
  recordingFrameAspectRatio,
  recordingFrameResetNonce = 0,
  toolbarOrientation = "horizontal",
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
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
  const [frameStyle, setFrameStyle] = useState<React.CSSProperties | null>(null);



  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setApiInstance(api);
  }, []);


  const updateRecordingFrameOverlay = useCallback(() => {
    if (!apiInstance || !wrapperRef.current || !recordingFrameAspectRatio) {
      setFrameStyle(null);
      return;
    }
    const frame = recordingFrameForAspectRatio(recordingFrameAspectRatio);
    const appState = apiInstance.getAppState();
    const zoom = appState.zoom.value;
    setFrameStyle({
      left: (frame.x + appState.scrollX) * zoom,
      top: (frame.y + appState.scrollY) * zoom,
      width: frame.width * zoom,
      height: frame.height * zoom,
    });
  }, [apiInstance, recordingFrameAspectRatio]);

  const fitRecordingFrame = useCallback(async () => {
    if (!apiInstance || !recordingFrameAspectRatio) return;
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const frameTarget = convertToExcalidrawElements([recordingFrameSkeleton(recordingFrameAspectRatio)])[0];
    if (!frameTarget) return;
    apiInstance.scrollToContent(frameTarget, recordingFrameFitOptions("editor"));
    requestAnimationFrame(updateRecordingFrameOverlay);
  }, [apiInstance, recordingFrameAspectRatio, updateRecordingFrameOverlay]);

  useEffect(() => {
    if (!apiInstance || !recordingFrameAspectRatio) return;
    const unsubscribe = apiInstance.onScrollChange(() => updateRecordingFrameOverlay());
    const observer = new ResizeObserver(() => updateRecordingFrameOverlay());
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    void fitRecordingFrame().catch(() => {});
    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [apiInstance, recordingFrameAspectRatio, fitRecordingFrame, updateRecordingFrameOverlay]);

  useEffect(() => {
    if (recordingFrameResetNonce <= 0) return;
    void fitRecordingFrame().catch(() => {});
  }, [recordingFrameResetNonce, fitRecordingFrame]);

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
    <div ref={wrapperRef} className={`relative w-full h-full excalidraw-toolbar-${toolbarOrientation}`}>
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
      {recordingFrameAspectRatio && frameStyle && (
        <div
          aria-hidden="true"
          className="absolute z-20 pointer-events-none border-2 border-blue-500/80 shadow-[0_0_0_1px_rgba(255,255,255,0.8)]"
          style={frameStyle}
        >
          <div className="absolute -top-7 left-0 rounded bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white shadow">
            Recording {recordingFrameAspectRatio}
          </div>
        </div>
      )}
      <style jsx global>{`
        .excalidraw-toolbar-vertical .shapes-section {
          position: absolute !important;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          z-index: var(--zIndex-layerUI);
        }
        .excalidraw-toolbar-vertical .App-toolbar-container {
          display: grid !important;
          grid-auto-flow: row !important;
          grid-template-columns: auto !important;
        }
        .excalidraw-toolbar-vertical .App-toolbar {
          width: auto !important;
        }
        .excalidraw-toolbar-vertical .App-toolbar .Stack_horizontal {
          grid-auto-flow: row !important;
          grid-template-rows: none !important;
          grid-template-columns: auto !important;
        }
        .excalidraw-toolbar-vertical .App-toolbar__divider {
          width: 100% !important;
          height: 1px !important;
          margin: 2px 0 !important;
        }
        .excalidraw-toolbar-horizontal .shapes-section {
          position: static;
        }
      `}</style>
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