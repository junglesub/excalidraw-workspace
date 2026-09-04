"use client";

import dynamic from "next/dynamic";
import "@excalidraw/excalidraw/index.css";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeckAspectRatio, ExcalidrawScene } from "@/lib/types";
import { recordingFrameFitOptions, recordingFrameSkeleton } from "@/lib/recording_frame";
import type { PresentationTool } from "@/lib/presentation";
import type { PresentationLaserSettings } from "@/lib/presentation_laser";
import {
  presentationElementsBounds,
  presentationPointerTool,
  presentationToolType,
  presentationTouchHitsSelectionBounds,
  scenePointForPointer,
} from "@/lib/presentation";
import {
  filesWithInlineDataURL,
  hydrateSceneInMemory,
  resetErroredImageElements,
} from "@/lib/client_attachments";

const BaseExcalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => mod.Excalidraw),
  { ssr: false },
);

interface Props {
  initialScene: ExcalidrawScene;
  docId: string;
  tool: PresentationTool;
  strokeColor: string;
  colorApplyNonce: number;
  onSceneChange: (scene: ExcalidrawScene) => void;
  undoNonce: number;
  penDetected: boolean;
  touchEnabled: boolean;
  laserSettings: PresentationLaserSettings;
  onPenDetected: () => void;
  aspectRatio: DeckAspectRatio;
}

export default function PresentationCanvas({
  initialScene,
  docId,
  tool,
  strokeColor,
  colorApplyNonce,
  onSceneChange,
  undoNonce,
  penDetected,
  touchEnabled,
  laserSettings,
  onPenDetected,
  aspectRatio,
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hydratedIdsRef = useRef<Set<string>>(new Set());
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const viewportLockRef = useRef(false);
  const laserPointerActiveRef = useRef(false);
  const [laserPoints, setLaserPoints] = useState<Array<{ x: number; y: number; at: number }>>([]);
  const [laserNow, setLaserNow] = useState(() => Date.now());



  const initialData = useMemo<ExcalidrawInitialDataState>(() => ({
    elements: resetErroredImageElements(
      Array.isArray(initialScene.elements) ? initialScene.elements : [],
    ) as readonly ExcalidrawElement[],
    appState: {
      ...(initialScene.appState && typeof initialScene.appState === "object"
        ? (initialScene.appState as unknown as Partial<AppState>)
        : {}),
      zenModeEnabled: true,
    },
    files: filesWithInlineDataURL(initialScene.files as Record<string, unknown>) as BinaryFiles,
  }), [initialScene]);

  const handleApi = useCallback((instance: ExcalidrawImperativeAPI) => {
    apiRef.current = instance;
    setApi(instance);
  }, []);

  const handleChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    onSceneChange({
      type: "excalidraw",
      version: 2,
      elements: elements as unknown[],
      appState: { viewBackgroundColor: appState.viewBackgroundColor },
      files: { ...(initialScene.files || {}), ...files },
    });
  }, [initialScene.files, onSceneChange]);

  const fitRecordingFrame = useCallback(async () => {
    if (!api || viewportLockRef.current) return;
    viewportLockRef.current = true;
    try {
      const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
      const frameTarget = convertToExcalidrawElements([recordingFrameSkeleton(aspectRatio)])[0];
      if (!frameTarget) return;
      api.scrollToContent(frameTarget, recordingFrameFitOptions("present"));
    } finally {
      requestAnimationFrame(() => { viewportLockRef.current = false; });
    }
  }, [api, aspectRatio]);

  const syncPresentationTool = useCallback(() => {
    if (!api) return;
    api.setActiveTool(tool === "laser"
      ? { type: "selection", locked: false }
      : { type: presentationToolType(tool), locked: tool !== "select" });
    api.updateScene({ appState: { currentItemStrokeColor: strokeColor } });
  }, [api, strokeColor, tool]);

  const applyStrokeColorToSelection = useCallback(async () => {
    if (!api || colorApplyNonce <= 0) return;
    const appState = api.getAppState();
    const selectedElementIds = appState.selectedElementIds;
    if (!Object.values(selectedElementIds).some(Boolean)) return;
    const { CaptureUpdateAction } = await import("@excalidraw/excalidraw");
    const now = Date.now();
    const elements = api.getSceneElements().map((element) => {
      if (!selectedElementIds[element.id]) return element;
      return {
        ...element,
        strokeColor,
        version: element.version + 1,
        versionNonce: Math.floor(Math.random() * 2_147_483_647),
        updated: now,
      } as ExcalidrawElement;
    });
    api.updateScene({
      elements,
      appState: { currentItemStrokeColor: strokeColor },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, [api, colorApplyNonce, strokeColor]);

  useEffect(() => {
    syncPresentationTool();
  }, [syncPresentationTool]);

  useEffect(() => {
    void applyStrokeColorToSelection();
  }, [applyStrokeColorToSelection]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    hydrateSceneInMemory(initialScene, api, {
      docId,
      signal: controller.signal,
      hydratedIds: hydratedIdsRef.current,
    }).finally(() => {
      if (controller.signal.aborted) return;
      syncPresentationTool();
      void fitRecordingFrame();
    }).catch(() => {});
    return () => controller.abort();
  }, [api, docId, initialScene, fitRecordingFrame, syncPresentationTool]);

  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onScrollChange(() => {
      if (!viewportLockRef.current) void fitRecordingFrame();
    });
    return unsubscribe;
  }, [api, fitRecordingFrame]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!api || !wrapper || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      void fitRecordingFrame();
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [api, fitRecordingFrame]);

  useEffect(() => {
    if (undoNonce <= 0) return;
    const target = wrapperRef.current?.querySelector<HTMLElement>(".excalidraw") ?? wrapperRef.current;
    if (!target) return;
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, [undoNonce]);

  const laserPointFromEvent = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, at: Date.now() };
  }, []);

  const pushLaserPoint = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const point = laserPointFromEvent(event);
    if (!point) return;
    setLaserNow(point.at);
    if (laserSettings.mode === "dot") {
      setLaserPoints([point]);
      return;
    }
    setLaserPoints((current) => [...current, point].slice(-laserSettings.trail.length));
  }, [laserPointFromEvent, laserSettings.mode, laserSettings.trail.length]);

  useEffect(() => {
    if (tool !== "laser") {
      laserPointerActiveRef.current = false;
      setLaserPoints([]);
      return;
    }
    if (laserSettings.mode !== "trail" || laserPoints.length === 0) return;
    let frame = 0;
    const tick = () => {
      const now = Date.now();
      setLaserNow(now);
      setLaserPoints((current) => current.filter((point) => now - point.at < laserSettings.trail.decayMs));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [laserPoints.length, laserSettings.mode, laserSettings.trail.decayMs, tool]);

  const pointerHitsBounds = useCallback((event: React.PointerEvent<HTMLDivElement>, elements: readonly ExcalidrawElement[], marginPx: number) => {
    if (!api || elements.length === 0) return false;
    const appState = api.getAppState();
    const point = scenePointForPointer(
      { clientX: event.clientX, clientY: event.clientY },
      appState,
    );
    return presentationTouchHitsSelectionBounds(
      point,
      presentationElementsBounds(elements),
      appState.zoom.value,
      marginPx,
    );
  }, [api]);

  const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "pen") onPenDetected();
    if (tool === "laser") {
      if (event.pointerType === "touch" && penDetected && !touchEnabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      laserPointerActiveRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pushLaserPoint(event);
      return;
    }
    if (!api) return;

    const appState = api.getAppState();
    const elements = api.getSceneElements();
    const selectedElements = elements.filter((element) => appState.selectedElementIds[element.id]);
    const selectedBoundsHit = pointerHitsBounds(event, selectedElements, 24);
    const anyElementHit = event.pointerType === "touch" && elements.some((element) =>
      pointerHitsBounds(event, [element], 6),
    );
    const selectionHit = selectedBoundsHit || anyElementHit;
    const pointerTool = presentationPointerTool(event.pointerType, penDetected, touchEnabled, selectionHit, tool);

    if (!pointerTool) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const excalidrawTool = presentationToolType(pointerTool);
    if ((event.pointerType === "touch" || event.pointerType === "pen") && excalidrawTool !== appState.activeTool.type) {
      api.setActiveTool({ type: excalidrawTool, locked: pointerTool !== "select" });
    }
  }, [api, onPenDetected, penDetected, pointerHitsBounds, pushLaserPoint, tool, touchEnabled]);

  const handlePointerMoveCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (tool === "laser" && laserPointerActiveRef.current) {
      event.preventDefault();
      event.stopPropagation();
      pushLaserPoint(event);
      return;
    }
    if (event.pointerType === "touch" && penDetected && !touchEnabled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [penDetected, pushLaserPoint, tool, touchEnabled]);

  const handlePointerEndCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (tool === "laser") {
      event.preventDefault();
      event.stopPropagation();
      laserPointerActiveRef.current = false;
      if (laserSettings.mode === "dot") setLaserPoints([]);
      return;
    }
    if (event.pointerType === "touch" && penDetected && !touchEnabled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [laserSettings.mode, penDetected, tool, touchEnabled]);

  return (
    <div
      ref={wrapperRef}
      className="presentation-excalidraw relative w-full h-full overflow-hidden bg-white"
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMoveCapture={handlePointerMoveCapture}
      onPointerUpCapture={handlePointerEndCapture}
      onPointerCancelCapture={handlePointerEndCapture}
      onWheelCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <BaseExcalidraw
        excalidrawAPI={handleApi}
        initialData={initialData}
        onChange={handleChange}
        zenModeEnabled
        detectScroll={false}
        handleKeyboardGlobally={false}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
            saveAsImage: false,
          },
          tools: { image: false },
        }}
        autoFocus
      />
      {tool === "laser" && laserPoints.length > 0 && (
        <div
          className="presentation-laser-overlay absolute inset-0 z-20 overflow-hidden"
          style={{ pointerEvents: "none" }}
          aria-hidden="true"
        >
          <svg className="absolute inset-0 h-full w-full overflow-visible">
            {(() => {
              const head = laserPoints[laserPoints.length - 1];
              const latestAge = Math.max(0, laserNow - head.at);
              const trailOpacity = laserPointerActiveRef.current
                ? 1
                : Math.max(0, 1 - latestAge / laserSettings.trail.decayMs);
              const isDot = laserSettings.mode === "dot";
              return (
                <>
                  {laserSettings.mode === "trail" && laserPoints.length > 1 && (
                    <polyline
                      points={laserPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                      fill="none"
                      stroke={laserSettings.trail.color}
                      strokeWidth={laserSettings.trail.coreSize}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={trailOpacity}
                      style={{ filter: `drop-shadow(0 0 ${laserSettings.trail.glowSize}px ${laserSettings.trail.color})` }}
                    />
                  )}
                  {(isDot || laserPointerActiveRef.current) && (
                    <circle
                      cx={head.x}
                      cy={head.y}
                      r={(isDot ? laserSettings.dot.size : laserSettings.trail.coreSize) / 2}
                      fill={isDot ? laserSettings.dot.color : laserSettings.trail.color}
                      style={{
                        filter: `drop-shadow(0 0 ${isDot ? laserSettings.dot.glowSize : laserSettings.trail.glowSize}px ${isDot ? laserSettings.dot.color : laserSettings.trail.color})`,
                      }}
                    />
                  )}
                </>
              );
            })()}
          </svg>
        </div>
      )}
      <style jsx global>{`
        .presentation-excalidraw .layer-ui__wrapper,
        .presentation-excalidraw .App-menu,
        .presentation-excalidraw .App-toolbar,
        .presentation-excalidraw .HintViewer,
        .presentation-excalidraw .mobile-misc-tools-container {
          display: none !important;
        }
        .presentation-excalidraw .excalidraw {
          --ui-font: system-ui, sans-serif;
        }
      `}</style>
    </div>
  );
}
