"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PresentationCanvas from "@/components/PresentationCanvas";
import { api } from "@/lib/client";
import { getEditorContextId } from "@/lib/client_edit_lease";
import {
  acquireDeckLease,
  getOrCreateDeckLeaseAttemptToken,
  heartbeatDeckLease,
  readStoredDeckLeaseCredentials,
  releaseDeckLease,
  storeDeckLeaseCredentials,
} from "@/lib/client_deck_edit_lease";
import { saveDocumentScene } from "@/lib/client_save";
import { isConfirmedDoubleTap, nextPresentationPageId, presentationSceneContentChanged } from "@/lib/presentation";
import {
  fullscreenAvailable,
  isFullscreenActive,
  isStandaloneDisplay,
  togglePresentationFullscreen,
} from "@/lib/presentation_fullscreen";
import type { PresentationTool } from "@/lib/presentation";
import type { DeckWithPages, EditLeaseCredentials, ExcalidrawScene } from "@/lib/types";
import {
  DEFAULT_PRESENTATION_LASER_SETTINGS,
  type PresentationLaserSettings,
} from "@/lib/presentation_laser";

type SessionStatus = "loading" | "ready" | "saving" | "blocked" | "error";

export default function PresentModeClient({ initialDeck }: { initialDeck: DeckWithPages }) {
  const router = useRouter();
  const [deck, setDeck] = useState(initialDeck);
  const [activePageId, setActivePageId] = useState<string | null>(initialDeck.pages[0]?.id ?? null);
  const [scene, setScene] = useState<ExcalidrawScene | null>(null);
  const [tool, setTool] = useState<PresentationTool>("pen");
  const [strokeColor, setStrokeColor] = useState("#1e1e1e");
  const [colorApplyNonce, setColorApplyNonce] = useState(0);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [undoNonce, setUndoNonce] = useState(0);
  const [penDetected, setPenDetected] = useState(false);
  const [touchEnabled, setTouchEnabled] = useState(false);
  const [resetArmedAt, setResetArmedAt] = useState<number | null>(null);
  const [deckLeaseReady, setDeckLeaseReady] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [standaloneDisplay, setStandaloneDisplay] = useState(false);
  const [laserSettings, setLaserSettings] = useState<PresentationLaserSettings>(DEFAULT_PRESENTATION_LASER_SETTINGS);

  const leaseRef = useRef<EditLeaseCredentials | null>(null);
  const sceneRef = useRef<ExcalidrawScene | null>(null);
  const persistedFileIdsRef = useRef<Set<string>>(new Set());
  const dirtyRef = useRef(false);
  const changeGenerationRef = useRef(0);
  const savingRef = useRef<Promise<void> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentDocIdRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);

  const activePage = deck.pages.find((page) => page.id === activePageId) ?? deck.pages[0] ?? null;
  const pageIds = deck.pages.map((page) => page.id);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setFullscreenActive(isFullscreenActive(document));
    const media = window.matchMedia("(display-mode: standalone)");
    const nav = navigator as Navigator & { standalone?: boolean };
    setStandaloneDisplay(isStandaloneDisplay({
      mediaMatches: media.matches,
      navigatorStandalone: nav.standalone === true,
    }));
    setFullscreenSupported(fullscreenAvailable(document));
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    api<{ settings: PresentationLaserSettings }>("/api/preferences/presentation-laser")
      .then((data) => setLaserSettings(data.settings))
      .catch(() => {});
  }, []);

  const toggleLaserMode = useCallback(() => {
    const mode = laserSettings.mode === "trail" ? "dot" : "trail";
    setLaserSettings((current) => ({ ...current, mode }));
    void api<{ settings: PresentationLaserSettings }>("/api/preferences/presentation-laser", {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    }).then((data) => setLaserSettings(data.settings)).catch(() => {});
  }, [laserSettings.mode]);

  function activateLaser() {
    if (tool === "laser") {
      toggleLaserMode();
      return;
    }
    setTool("laser");
  }

  useEffect(() => {
    let active = true;
    const contextId = getEditorContextId();
    const stored = readStoredDeckLeaseCredentials(sessionStorage, deck.id, contextId);
    const leaseToken = stored?.leaseToken ?? getOrCreateDeckLeaseAttemptToken(sessionStorage, deck.id, contextId);
    setStatus("loading");
    setDeckLeaseReady(false);

    acquireDeckLease(deck.id, { clientId: contextId, leaseToken })
      .then((result) => {
        if (!active) return;
        if (result.state !== "acquired") {
          setStatus("blocked");
          setMessage(result.state === "held" ? `This Deck is being edited by ${result.holder.username}.` : "This Deck is locked for editing.");
          return;
        }
        const credentials: EditLeaseCredentials = {
          clientId: result.clientId,
          leaseToken: result.leaseToken,
          generation: result.generation,
        };
        leaseRef.current = credentials;
        storeDeckLeaseCredentials(sessionStorage, deck.id, contextId, {
          leaseToken: credentials.leaseToken,
          generation: credentials.generation,
        });
        setDeckLeaseReady(true);

        stopHeartbeat();
        heartbeatRef.current = setInterval(() => {
          const current = leaseRef.current;
          if (!current) return;
          heartbeatDeckLease(deck.id, current)
            .then((heartbeat) => {
              if (heartbeat.state !== "acquired") {
                setStatus("blocked");
                setMessage("Deck edit lease was lost. Exit Present Mode or resolve the other editor first.");
              }
            })
            .catch(() => {
              setStatus("error");
              setMessage("Could not renew the Deck edit lease.");
            });
        }, 30_000);
      })
      .catch((err) => {
        if (!active) return;
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Failed to acquire Deck edit lease");
      });

    return () => {
      active = false;
      stopHeartbeat();
    };
  }, [deck.id, stopHeartbeat]);

  useEffect(() => {
    const handlePageHide = () => {
      const lease = leaseRef.current;
      if (!lease) return;
      void releaseDeckLease(deck.id, lease).catch(() => {});
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [deck.id]);

  const saveCurrent = useCallback(async () => {
    while (dirtyRef.current) {
      if (savingRef.current) {
        await savingRef.current;
        continue;
      }
      if (!sceneRef.current || !currentDocIdRef.current) return;
      const lease = leaseRef.current;
      if (!lease) throw new Error("Deck edit lease is unavailable");

      setStatus("saving");
      const generation = changeGenerationRef.current;
      const work = saveDocumentScene({
        docId: currentDocIdRef.current,
        scene: sceneRef.current,
        persistedFileIds: persistedFileIdsRef.current,
        lease,
        leaseScope: "deck",
        deckId: deck.id,
        snapshotDue: false,
      }).then(() => {
        if (changeGenerationRef.current === generation) {
          dirtyRef.current = false;
          setStatus("ready");
        }
      }).catch((err) => {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Failed to save presentation annotations");
        throw err;
      }).finally(() => {
        savingRef.current = null;
      });
      savingRef.current = work;
      await work;
    }
  }, [deck.id]);

  const openPage = useCallback(async (pageId: string) => {
    const page = deck.pages.find((item) => item.id === pageId);
    if (!page || !deckLeaseReady) return;
    const epoch = ++loadEpochRef.current;
    setStatus("loading");
    setMessage(null);
    setScene(null);
    dirtyRef.current = false;
    currentDocIdRef.current = page.documentId;

    try {
      const data = await api<{ scene: ExcalidrawScene }>(`/api/documents/${page.documentId}`);
      if (epoch !== loadEpochRef.current) return;
      sceneRef.current = data.scene;
      persistedFileIdsRef.current = new Set(Object.keys(data.scene.files || {}));
      setScene(data.scene);
      setStatus("ready");
    } catch (err) {
      if (epoch !== loadEpochRef.current) return;
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to open presentation page");
    }
  }, [deck.pages, deckLeaseReady]);

  useEffect(() => {
    if (activePageId && deckLeaseReady) void openPage(activePageId);
  }, [activePageId, deckLeaseReady, openPage]);

  useEffect(() => () => {
    loadEpochRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const handleSceneChange = useCallback((next: ExcalidrawScene) => {
    const previous = sceneRef.current;
    sceneRef.current = next;
    if (!previous || !presentationSceneContentChanged(previous, next)) return;
    changeGenerationRef.current += 1;
    dirtyRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void saveCurrent().catch(() => {}), 1500);
  }, [saveCurrent]);

  async function toggleFullscreen() {
    const result = await togglePresentationFullscreen(document, document.documentElement);
    if (result === "failed") setMessage("Fullscreen request was not accepted by the browser.");
    if (result === "unsupported") setMessage("Fullscreen is unavailable here. Install the app to the Home Screen for a browser-chrome-free presentation.");
  }

  async function navigate(direction: "previous" | "next") {
    const target = nextPresentationPageId(pageIds, activePageId, direction);
    if (!target || target === activePageId || status === "loading" || status === "blocked") return;
    try {
      await saveCurrent();
      setActivePageId(target);
    } catch {
      setMessage("Page change cancelled because annotations could not be saved.");
    }
  }

  async function exitPresent() {
    try {
      await saveCurrent();
      router.push(`/decks/${deck.id}`);
    } catch {
      setMessage("Exit cancelled because annotations could not be saved.");
    }
  }

  async function resetCurrent() {
    if (!activePage) return;
    const now = Date.now();
    if (!isConfirmedDoubleTap(resetArmedAt, now)) {
      setResetArmedAt(now);
      return;
    }
    setResetArmedAt(null);
    try {
      await saveCurrent();
      await api(`/api/decks/${deck.id}/baseline/reset`, {
        method: "POST",
        body: JSON.stringify({ scope: "current", pageId: activePage.id, deckLease: leaseRef.current }),
      });
      const fresh = await api<{ deck: DeckWithPages }>(`/api/decks/${deck.id}`);
      setDeck(fresh.deck);
      const data = await api<{ scene: ExcalidrawScene }>(`/api/documents/${activePage.documentId}`);
      sceneRef.current = data.scene;
      persistedFileIdsRef.current = new Set(Object.keys(data.scene.files || {}));
      dirtyRef.current = false;
      setScene(data.scene);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Reset failed");
    }
  }

  useEffect(() => {
    if (resetArmedAt === null) return;
    const timer = setTimeout(() => setResetArmedAt(null), 2_000);
    return () => clearTimeout(timer);
  }, [resetArmedAt]);

  useEffect(() => {
    setResetArmedAt(null);
  }, [activePageId, tool, touchEnabled]);

  const pageIndex = activePage ? deck.pages.findIndex((page) => page.id === activePage.id) : -1;
  const controlsDisabled = status === "loading" || status === "blocked" || !deckLeaseReady;
  const landscape = deck.aspectRatio === "16:9";
  const colors = ["#1e1e1e", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#9c36b5"];

  const toolbar = !controlsHidden ? (
    <aside
      className={`${landscape
        ? "present-toolbar-landscape w-full min-h-20 flex-row px-3 py-2"
        : "present-toolbar-portrait h-full w-24 flex-col px-2 py-3"
      } shrink-0 bg-slate-950 border-slate-800 flex items-center justify-center gap-2 overflow-auto ${landscape ? "border-t" : "border-l"}`}
    >
      <button type="button" aria-label="Previous page" title="Previous page" disabled={controlsDisabled || pageIndex <= 0} onClick={() => void navigate("previous")} className="h-12 w-12 rounded-lg bg-slate-800 border border-slate-700 disabled:opacity-30 flex items-center justify-center">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="m15 5-7 7 7 7" /></svg>
      </button>
      <span className="h-12 min-w-14 px-2 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-sm tabular-nums">{pageIndex >= 0 ? `${pageIndex + 1}/${deck.pages.length}` : "-"}</span>
      <button type="button" aria-label="Next page" title="Next page" disabled={controlsDisabled || pageIndex < 0 || pageIndex >= deck.pages.length - 1} onClick={() => void navigate("next")} className="h-12 w-12 rounded-lg bg-slate-800 border border-slate-700 disabled:opacity-30 flex items-center justify-center">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="m9 5 7 7-7 7" /></svg>
      </button>

      <button type="button" aria-label="Select" title="Select" disabled={controlsDisabled} onClick={() => setTool("select")} className={`h-12 w-12 rounded-lg border flex items-center justify-center ${tool === "select" ? "bg-slate-600 border-slate-300" : "bg-slate-800 border-slate-700"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="m5 3 12 9-6 1-3 6z" /></svg>
      </button>
      <button type="button" aria-label="Pen" title="Pen" disabled={controlsDisabled} onClick={() => setTool("pen")} className={`h-12 w-12 rounded-lg border flex items-center justify-center ${tool === "pen" ? "bg-blue-600 border-blue-400" : "bg-slate-800 border-slate-700"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="m4 20 4-1 10-10-3-3L5 16z" /><path d="m13 8 3 3" /></svg>
      </button>
      <button type="button" aria-label="Rectangle" title="Rectangle" disabled={controlsDisabled} onClick={() => setTool("rectangle")} className={`h-12 w-12 rounded-lg border flex items-center justify-center ${tool === "rectangle" ? "bg-indigo-600 border-indigo-400" : "bg-slate-800 border-slate-700"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><rect x="4" y="5" width="16" height="14" rx="1" /></svg>
      </button>
      <button type="button" aria-label="Ellipse" title="Ellipse" disabled={controlsDisabled} onClick={() => setTool("ellipse")} className={`h-12 w-12 rounded-lg border flex items-center justify-center ${tool === "ellipse" ? "bg-violet-600 border-violet-400" : "bg-slate-800 border-slate-700"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><ellipse cx="12" cy="12" rx="8" ry="6" /></svg>
      </button>
      <button type="button" aria-label="Eraser" title="Eraser" disabled={controlsDisabled} onClick={() => setTool("eraser")} className={`h-12 w-12 rounded-lg border flex items-center justify-center ${tool === "eraser" ? "bg-amber-600 border-amber-400" : "bg-slate-800 border-slate-700"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="m7 18-3-3 9-9 5 5-7 7z" /><path d="M10 18h9" /></svg>
      </button>
      <button type="button" aria-label="Laser" title={`Laser ${laserSettings.mode === "trail" ? "Trail" : "Dot"}`} disabled={controlsDisabled} onClick={activateLaser} className={`h-12 w-12 rounded-lg border flex items-center justify-center ${tool === "laser" ? "bg-rose-600 border-rose-400" : "bg-slate-800 border-slate-700"}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
      </button>

      <div className={`${landscape ? "flex-row" : "flex-col"} flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800`}>
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Pen color ${color}`}
            disabled={controlsDisabled}
            onClick={() => { setStrokeColor(color); setColorApplyNonce((value) => value + 1); }}
            className={`w-8 h-8 rounded-full border-2 ${strokeColor === color ? "border-white" : "border-slate-600"} disabled:opacity-30`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>

      <button
        type="button"
        aria-label="Undo"
        title="Undo"
        disabled={controlsDisabled || !scene}
        onClick={() => setUndoNonce((value) => value + 1)}
        className="h-12 w-12 rounded-lg bg-slate-800 border border-slate-700 disabled:opacity-30 flex items-center justify-center"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2">
          <path d="M9 7 4 12l5 5" />
          <path d="M5 12h8a6 6 0 0 1 6 6" />
        </svg>
      </button>
      {penDetected && (
        <button
          type="button"
          aria-label={touchEnabled ? "Turn touch off" : "Turn touch on"}
          title={touchEnabled ? "Touch on: selection first, current tool on empty space" : "Touch off"}
          onClick={() => setTouchEnabled((value) => !value)}
          className={`h-10 w-10 rounded border flex items-center justify-center ${touchEnabled ? "bg-emerald-700 border-emerald-400" : "bg-slate-800 border-slate-700"}`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current stroke-2">
            <path d="M8 11V6a1.5 1.5 0 0 1 3 0v4" />
            <path d="M11 10V5a1.5 1.5 0 0 1 3 0v5" />
            <path d="M14 10V7a1.5 1.5 0 0 1 3 0v6" />
            <path d="M8 11 6.8 9.8a1.5 1.5 0 0 0-2.1 2.1l4.5 5.4A5 5 0 0 0 13 19h1a4 4 0 0 0 4-4v-2" />
            {!touchEnabled && <path d="M4 4l16 16" />}
          </svg>
        </button>
      )}
      {!standaloneDisplay && fullscreenSupported && (
        fullscreenActive ? (
          <button type="button" aria-label="Exit full screen" title="Exit full screen" onClick={() => void toggleFullscreen()} className="h-12 w-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" /></svg>
          </button>
        ) : (
          <button type="button" aria-label="Full screen" title="Full screen" onClick={() => void toggleFullscreen()} className="h-12 w-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="M3 9V3h6M15 3h6v6M3 15v6h6M21 15v6h-6" /></svg>
          </button>
        )
      )}
      <button
        type="button"
        aria-label="Reset current page"
        title={resetArmedAt === null ? "Reset current page" : "Tap again to reset"}
        disabled={controlsDisabled}
        onClick={() => void resetCurrent()}
        className={`h-12 w-12 rounded-lg border disabled:opacity-30 flex items-center justify-center ${resetArmedAt === null ? "bg-slate-800 border-slate-700" : "bg-amber-700 border-amber-400"}`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="M4 4v6h6" /><path d="M5 10a8 8 0 1 1 2 8" /></svg>
      </button>
      <button type="button" aria-label="Hide controls" title="Hide controls" onClick={() => setControlsHidden(true)} className="h-12 w-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="M3 3l18 18" /><path d="M10.5 10.7a2 2 0 0 0 2.8 2.8" /><path d="M9.9 4.2A10.7 10.7 0 0 1 12 4c5 0 9 4 10 8a11 11 0 0 1-2.2 4.1M6.6 6.6A11.6 11.6 0 0 0 2 12c1 4 5 8 10 8 1 0 2-.2 2.9-.5" /></svg>
      </button>
      <button type="button" aria-label="Exit Present Mode" title="Exit Present Mode" onClick={() => void exitPresent()} className="h-12 w-12 rounded-lg bg-slate-800 border border-red-900 text-red-300 flex items-center justify-center">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6 fill-none stroke-current stroke-2"><path d="M10 5H5v14h5" /><path d="M14 8l4 4-4 4M9 12h9" /></svg>
      </button>
    </aside>
  ) : null;

  return (
    <div className={`w-screen h-[100dvh] bg-slate-950 text-white overflow-hidden select-none flex ${landscape ? "flex-col" : "flex-row"}`}>
      <main className="flex-1 min-w-0 min-h-0 flex items-center justify-center overflow-hidden">
        <div className="w-full h-full flex items-center justify-center overflow-hidden">
          <div className={`${landscape ? "aspect-video max-h-full w-full" : "aspect-[9/16] h-full max-w-full"} bg-white overflow-hidden`}>
            {scene && status !== "blocked" ? (
              <PresentationCanvas
                key={activePage?.documentId}
                initialScene={scene}
                docId={activePage!.documentId}
                tool={tool}
                strokeColor={strokeColor}
                colorApplyNonce={colorApplyNonce}
                onSceneChange={handleSceneChange}
                undoNonce={undoNonce}
                penDetected={penDetected}
                touchEnabled={touchEnabled}
                laserSettings={laserSettings}
                onPenDetected={() => setPenDetected(true)}
                aspectRatio={deck.aspectRatio}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-white text-slate-700 p-8 text-center">
                {message || "Loading page..."}
              </div>
            )}
          </div>
        </div>
      </main>

      {toolbar}

      {controlsHidden && (
        <button
          type="button"
          aria-label="Show controls"
          title="Show controls"
          onClick={() => setControlsHidden(false)}
          className="fixed bottom-2 right-2 z-50 w-10 h-10 rounded-full bg-slate-950/70 border border-slate-700 text-white opacity-60 hover:opacity-100 flex items-center justify-center"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current stroke-2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      )}

      {message && status === "error" && (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 bg-red-950/90 border border-red-800 text-red-100 rounded-lg px-3 py-2 text-sm">{message}</div>
      )}
    </div>
  );
}
