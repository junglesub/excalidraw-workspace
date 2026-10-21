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
import {
  getFontFamilyCss,
  scenePointForClientPoint,
  stripUrlTextStyle,
  urlTextAtScenePoint,
  urlTextUnderlines,
  type UrlTextUnderline,
} from "@/lib/url_text";

interface UrlTextOverlayState {
  transform: string;
  lines: UrlTextUnderline[];
  editingId: string | null;
}

function isE2EIntegration(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    Boolean(window.location?.search?.includes("e2e=true"))
  );
}

function sameUrlUnderlines(a: readonly UrlTextUnderline[], b: readonly UrlTextUnderline[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => {
    const other = b[index];
    const covA = line.coveringElements || [];
    const covB = other.coveringElements || [];
    if (covA.length !== covB.length) return false;
    const sameCov = covA.every((c, i) => {
      const o = covB[i];
      return (
        c.type === o.type &&
        c.x === o.x &&
        c.y === o.y &&
        c.cx === o.cx &&
        c.cy === o.cy &&
        c.width === o.width &&
        c.height === o.height &&
        c.angle === o.angle
      );
    });
    if (!sameCov) return false;
    return (
      line.id === other.id &&
      line.x === other.x &&
      line.y === other.y &&
      line.width === other.width &&
      line.height === other.height &&
      line.angle === other.angle &&
      line.text === other.text &&
      line.fontSize === other.fontSize &&
      line.fontFamily === other.fontFamily &&
      line.textAlign === other.textAlign &&
      line.baseline === other.baseline &&
      line.opacity === other.opacity &&
      line.underlineTop === other.underlineTop &&
      line.underlineHeight === other.underlineHeight &&
      line.color === other.color
    );
  });
}

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
  const urlOverlayRef = useRef<UrlTextOverlayState>({ transform: "", lines: [], editingId: null });
  const [urlOverlay, setUrlOverlay] = useState<UrlTextOverlayState>({ transform: "", lines: [], editingId: null });

  const publishUrlOverlay = useCallback((lines?: UrlTextUnderline[], editingId?: string | null) => {
    const api = apiRef.current;
    if (!api) return;
    const appState = api.getAppState();
    const currentEditingId = editingId !== undefined ? editingId : (appState.editingTextElement?.id ?? null);
    const next: UrlTextOverlayState = {
      transform: `scale(${appState.zoom.value}) translate(${appState.scrollX}px, ${appState.scrollY}px)`,
      lines: lines ?? urlOverlayRef.current.lines,
      editingId: currentEditingId,
    };
    const previous = urlOverlayRef.current;
    if (
      previous.transform === next.transform &&
      previous.editingId === next.editingId &&
      sameUrlUnderlines(previous.lines, next.lines)
    ) {
      return;
    }
    urlOverlayRef.current = next;
    setUrlOverlay(next);
  }, []);

  const emitSceneChange = useCallback(
    (displayElements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const seedFiles = (initialScene.files as BinaryFiles) || {};
      const outgoingScene = {
        type: "excalidraw",
        version: 2,
        elements: stripUrlTextStyle(displayElements) as unknown[],
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
        },
        // Compact metadata stays until addFiles lands, so autosave cannot wipe fileIds.
        files: { ...seedFiles, ...files },
      } as ExcalidrawScene;
      if (isE2EIntegration()) {
        (window as any).__lastSavedScene = outgoingScene;
      }
      onSceneChange(outgoingScene);
    },
    [onSceneChange, initialScene.files],
  );

  const handleSceneChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      emitSceneChange(elements, appState, files);
      publishUrlOverlay(urlTextUnderlines(elements), appState.editingTextElement?.id ?? null);
    },
    [emitSceneChange, publishUrlOverlay],
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
    if (isE2EIntegration()) {
      (window as any).__excalidrawAPI = api;
    }
    setApiInstance(api);
  }, []);

  useEffect(() => {
    return () => {
      if (isE2EIntegration()) {
        delete (window as any).__excalidrawAPI;
        delete (window as any).__lastSavedScene;
      }
    };
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
    if (!apiInstance) return;
    publishUrlOverlay(urlTextUnderlines(apiInstance.getSceneElements()));
    return apiInstance.onScrollChange(() => publishUrlOverlay());
  }, [apiInstance, publishUrlOverlay]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handleUrlPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const api = apiRef.current;
      if (!api) return;
      const appState = api.getAppState();
      if (appState.activeTool.type !== "selection" || appState.editingTextElement) return;
      const point = scenePointForClientPoint(
        { clientX: event.clientX, clientY: event.clientY },
        wrapper.getBoundingClientRect(),
        {
          zoom: appState.zoom.value,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
        },
      );
      const hit = urlTextAtScenePoint(api.getSceneElements(), point);
      if (!hit) return;
      // Elements with an explicit link keep Excalidraw's own link handling.
      if (hit.element.link) return;
      window.open(hit.href, "_blank", "noopener,noreferrer");
    };
    wrapper.addEventListener("pointerdown", handleUrlPointerDown, true);
    return () => wrapper.removeEventListener("pointerdown", handleUrlPointerDown, true);
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
      {urlOverlay.lines.length > 0 && (
        <div
          aria-hidden="true"
          data-testid="url-text-underlines"
          className="absolute inset-0 z-10 overflow-hidden pointer-events-none select-none"
        >
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: urlOverlay.transform }}>
            {urlOverlay.lines.map((line) => {
              if (line.id === urlOverlay.editingId) return null;
              const textX =
                line.textAlign === "center"
                  ? line.width / 2
                  : line.textAlign === "right"
                  ? line.width
                  : 0;
              const textAnchor =
                line.textAlign === "center"
                  ? "middle"
                  : line.textAlign === "right"
                  ? "end"
                  : "start";
              return (
                <div
                  key={line.id}
                  className="absolute pointer-events-none select-none"
                  style={{
                    left: line.x,
                    top: line.y,
                    width: line.width,
                    height: line.height,
                    opacity: line.opacity,
                    transform: line.angle ? `rotate(${line.angle}rad)` : undefined,
                  }}
                >
                  <svg
                    className="absolute inset-0 w-full h-full overflow-visible pointer-events-none select-none"
                    aria-hidden="true"
                  >
                    {line.coveringElements && line.coveringElements.length > 0 && (
                      <mask id={`url-mask-${line.id}`}>
                        <rect x="-50000" y="-50000" width="100000" height="100000" fill="white" />
                        {line.coveringElements.map((cov, idx) => {
                          const transform = cov.angle
                            ? `rotate(${(cov.angle * 180) / Math.PI} ${cov.cx} ${cov.cy})`
                            : undefined;
                          if (cov.type === "ellipse") {
                            return (
                              <ellipse
                                key={idx}
                                cx={cov.cx}
                                cy={cov.cy}
                                rx={cov.width / 2}
                                ry={cov.height / 2}
                                transform={transform}
                                fill="black"
                              />
                            );
                          }
                          if (cov.type === "diamond") {
                            const halfW = cov.width / 2;
                            const halfH = cov.height / 2;
                            const pts = `${cov.cx},${cov.cy - halfH} ${cov.cx + halfW},${cov.cy} ${cov.cx},${cov.cy + halfH} ${cov.cx - halfW},${cov.cy}`;
                            return (
                              <polygon
                                key={idx}
                                points={pts}
                                transform={transform}
                                fill="black"
                              />
                            );
                          }
                          return (
                            <rect
                              key={idx}
                              x={cov.x}
                              y={cov.y}
                              width={cov.width}
                              height={cov.height}
                              transform={transform}
                              fill="black"
                            />
                          );
                        })}
                      </mask>
                    )}
                    <g mask={line.coveringElements && line.coveringElements.length > 0 ? `url(#url-mask-${line.id})` : undefined}>
                      <text
                        x={textX}
                        y={line.baseline}
                        textAnchor={textAnchor}
                        fill={line.color}
                        stroke={line.color}
                        strokeWidth="0.5"
                        paintOrder="stroke fill"
                        fontFamily={getFontFamilyCss(line.fontFamily)}
                        fontSize={`${line.fontSize}px`}
                      >
                        {line.text}
                      </text>
                      <rect
                        x="0"
                        y={line.underlineTop}
                        width={line.width}
                        height={line.underlineHeight}
                        rx="1"
                        fill={line.color}
                      />
                    </g>
                  </svg>
                </div>
              );
            })}
          </div>
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
        onChange={handleSceneChange}
        viewModeEnabled={readOnly}
        UIOptions={uiOptions}
        theme={theme}
        autoFocus={!readOnly}
      />
    </div>
  );
}