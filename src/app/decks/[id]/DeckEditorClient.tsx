"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { deckEditorChrome, movePageId } from "@/lib/deck_editor";
import { isConfirmedDoubleTap } from "@/lib/presentation";
import { getEditorContextId } from "@/lib/client_edit_lease";
import {
  acquireDeckLease,
  getOrCreateDeckLeaseAttemptToken,
  heartbeatDeckLease,
  pollDeckTakeover,
  readStoredDeckLeaseCredentials,
  releaseDeckLease,
  requestDeckTakeover,
  storeDeckLeaseCredentials,
} from "@/lib/client_deck_edit_lease";
import type { DeckAspectRatio, DeckWithPages, EditLeaseCredentials, PublicUser } from "@/lib/types";
import EmbeddedPageEditor from "./EmbeddedPageEditor";
import type { EditorClientControl } from "@/app/documents/[id]/EditorClient";
import type { NamedSnapshot, RecordingBaseline } from "@/lib/presentation_snapshots";
import {
  DEFAULT_PRESENTATION_LASER_SETTINGS,
  normalizePresentationLaserSettings,
  type PresentationLaserSettings,
  type PresentationLaserSettingsPatch,
} from "@/lib/presentation_laser";

export default function DeckEditorClient({ initialDeck, initialUser }: { initialDeck: DeckWithPages; initialUser: PublicUser }) {
  const router = useRouter();
  const [deck, setDeck] = useState(initialDeck);
  const [activePageId, setActivePageId] = useState<string | null>(initialDeck.pages[0]?.id ?? null);
  const [draggingPageId, setDraggingPageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<RecordingBaseline | null>(null);
  const [snapshots, setSnapshots] = useState<NamedSnapshot[]>([]);
  const [editorRevision, setEditorRevision] = useState(0);
  const [deckLeaseCredentials, setDeckLeaseCredentials] = useState<EditLeaseCredentials | null>(null);
  const [deckLeaseStatus, setDeckLeaseStatus] = useState<"acquiring" | "active" | "blocked" | "lost">("acquiring");
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [baselineResetArmed, setBaselineResetArmed] = useState<{ scope: "current" | "all"; at: number } | null>(null);
  const [laserSettings, setLaserSettings] = useState<PresentationLaserSettings>(DEFAULT_PRESENTATION_LASER_SETTINGS);
  const deckLeaseRef = useRef<EditLeaseCredentials | null>(null);
  const deckLeaseAttemptRef = useRef<{ clientId: string; leaseToken: string } | null>(null);
  const editorControlRef = useRef<EditorClientControl | null>(null);

  const activePage = deck.pages.find((page) => page.id === activePageId) ?? deck.pages[0] ?? null;
  const pageIds = useMemo(() => deck.pages.map((page) => page.id), [deck.pages]);
  const editorChrome = deckEditorChrome(deck.aspectRatio);
  const externalDeckLease = useMemo(
    () => deckLeaseCredentials ? { deckId: deck.id, credentials: deckLeaseCredentials } : null,
    [deck.id, deckLeaseCredentials],
  );

  useEffect(() => {
    let active = true;
    const contextId = getEditorContextId();
    const stored = readStoredDeckLeaseCredentials(sessionStorage, deck.id, contextId);
    const leaseToken = stored?.leaseToken ?? getOrCreateDeckLeaseAttemptToken(sessionStorage, deck.id, contextId);
    deckLeaseAttemptRef.current = { clientId: contextId, leaseToken };
    setDeckLeaseStatus("acquiring");
    acquireDeckLease(deck.id, { clientId: contextId, leaseToken })
      .then((result) => {
        if (!active) return;
        if (result.state !== "acquired") {
          setDeckLeaseStatus("blocked");
          setError(result.state === "held" ? `This Deck is being edited by ${result.holder.username}.` : "This Deck is locked for editing.");
          return;
        }
        const credentials = { clientId: result.clientId, leaseToken: result.leaseToken, generation: result.generation };
        deckLeaseRef.current = credentials;
        setDeckLeaseCredentials(credentials);
        storeDeckLeaseCredentials(sessionStorage, deck.id, contextId, { leaseToken: credentials.leaseToken, generation: credentials.generation });
        setDeckLeaseStatus("active");
      })
      .catch((err) => {
        if (!active) return;
        setDeckLeaseStatus("lost");
        setError(err instanceof Error ? err.message : "Failed to acquire Deck edit lease");
      });
    return () => { active = false; };
  }, [deck.id]);

  useEffect(() => {
    if (deckLeaseStatus !== "active" || !deckLeaseCredentials) return;
    const timer = setInterval(() => {
      heartbeatDeckLease(deck.id, deckLeaseCredentials)
        .then((result) => {
          if (result.state !== "acquired") {
            setDeckLeaseStatus("lost");
            setError("Deck edit lease was lost.");
          }
        })
        .catch(() => {
          setDeckLeaseStatus("lost");
          setError("Could not renew the Deck edit lease.");
        });
    }, 30_000);
    return () => clearInterval(timer);
  }, [deck.id, deckLeaseCredentials, deckLeaseStatus]);

  useEffect(() => {
    const handlePageHide = () => {
      const credentials = deckLeaseRef.current;
      if (!credentials) return;
      void releaseDeckLease(deck.id, credentials).catch(() => {});
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [deck.id]);

  useEffect(() => {
    api<{ baseline: RecordingBaseline | null }>(`/api/decks/${deck.id}/baseline`)
      .then((data) => setBaseline(data.baseline))
      .catch(() => {});
  }, [deck.id]);

  useEffect(() => {
    api<{ settings: PresentationLaserSettings }>("/api/preferences/presentation-laser")
      .then((data) => setLaserSettings(data.settings))
      .catch(() => {});
  }, []);

  function updateLaserSettings(patch: PresentationLaserSettingsPatch) {
    const optimistic = normalizePresentationLaserSettings(patch, laserSettings);
    setLaserSettings(optimistic);
    void api<{ settings: PresentationLaserSettings }>("/api/preferences/presentation-laser", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((data) => setLaserSettings(data.settings)).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not save Laser settings");
    });
  }

  useEffect(() => {
    if (!activePage) {
      setSnapshots([]);
      return;
    }
    api<{ snapshots: NamedSnapshot[] }>(`/api/decks/${deck.id}/pages/${activePage.id}/snapshots`)
      .then((data) => setSnapshots(data.snapshots))
      .catch(() => setSnapshots([]));
  }, [deck.id, activePage?.id]);

  async function takeOverDeck() {
    const identity = deckLeaseAttemptRef.current;
    if (!identity || takeoverBusy) return;
    setTakeoverBusy(true);
    setError("Requesting Deck takeover...");
    try {
      const requested = await requestDeckTakeover(deck.id, identity);
      if (requested.state === "acquired") {
        const credentials = { clientId: requested.clientId, leaseToken: requested.leaseToken, generation: requested.generation };
        deckLeaseRef.current = credentials;
        setDeckLeaseCredentials(credentials);
        storeDeckLeaseCredentials(sessionStorage, deck.id, identity.clientId, { leaseToken: credentials.leaseToken, generation: credentials.generation });
        setDeckLeaseStatus("active");
        setError(null);
        return;
      }
      if (requested.state !== "takeover_pending") {
        setError("Another takeover request is already in progress.");
        return;
      }
      setDeckLeaseStatus("acquiring");
      setError("Waiting for the current editor to release the Deck...");
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const result = await pollDeckTakeover(deck.id, { ...identity, requestId: requested.requestId });
        if (result.state === "acquired") {
          const credentials = { clientId: result.clientId, leaseToken: result.leaseToken, generation: result.generation };
          deckLeaseRef.current = credentials;
          setDeckLeaseCredentials(credentials);
          storeDeckLeaseCredentials(sessionStorage, deck.id, identity.clientId, { leaseToken: credentials.leaseToken, generation: credentials.generation });
          setDeckLeaseStatus("active");
          setError(null);
          return;
        }
        if (result.state !== "takeover_pending") {
          setDeckLeaseStatus("blocked");
          setError("Deck takeover could not be completed.");
          return;
        }
      }
    } catch (err) {
      setDeckLeaseStatus("blocked");
      setError(err instanceof Error ? err.message : "Deck takeover failed");
    } finally {
      setTakeoverBusy(false);
    }
  }

  async function mutate<T>(fn: () => Promise<T>, apply: (value: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const value = await fn();
      apply(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deck update failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshDeck() {
    const data = await api<{ deck: DeckWithPages }>(`/api/decks/${deck.id}`);
    setDeck(data.deck);
  }

  async function flushEditor(release = false) {
    const control = editorControlRef.current;
    if (!control) return;
    if (release) await control.flushAndRelease();
    else await control.flush();
  }

  async function enterPresent() {
    if (deckLeaseStatus !== "active" || !deckLeaseCredentials) return;
    if (!editorControlRef.current) {
      setError("Present is not ready yet. Wait for the current Page editor to finish loading.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await flushEditor();
      router.push(`/decks/${deck.id}/present`);
    } catch (err) {
      setError(err instanceof Error ? `Present cancelled: ${err.message}` : "Present cancelled because the current Page could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function createBlank() {
    await flushEditor();
    await mutate(
      () => api<{ deck: DeckWithPages; page: DeckWithPages["pages"][number] }>(`/api/decks/${deck.id}/pages`, {
        method: "POST",
        body: JSON.stringify({ action: "blank" }),
      }),
      (data) => {
        setDeck(data.deck);
        setActivePageId(data.page.id);
      },
    );
  }

  async function duplicateActive() {
    if (!activePage) return;
    await flushEditor();
    await mutate(
      () => api<{ deck: DeckWithPages; page: DeckWithPages["pages"][number] }>(`/api/decks/${deck.id}/pages`, {
        method: "POST",
        body: JSON.stringify({ action: "duplicate", pageId: activePage.id }),
      }),
      (data) => {
        setDeck(data.deck);
        setActivePageId(data.page.id);
      },
    );
  }

  async function renameActive() {
    if (!activePage) return;
    const title = window.prompt("Page title", activePage.title)?.trim();
    if (!title || title === activePage.title) return;
    await mutate(
      () => api<{ deck: DeckWithPages }>(`/api/decks/${deck.id}/pages/${activePage.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
      (data) => setDeck(data.deck),
    );
  }

  async function deleteActive() {
    if (!activePage || !window.confirm(`Delete ${activePage.title}?`)) return;
    await flushEditor(true);
    const oldIndex = deck.pages.findIndex((page) => page.id === activePage.id);
    await mutate(
      () => api<{ deck: DeckWithPages }>(`/api/decks/${deck.id}/pages/${activePage.id}`, { method: "DELETE" }),
      (data) => {
        setDeck(data.deck);
        setActivePageId(data.deck.pages[Math.min(oldIndex, data.deck.pages.length - 1)]?.id ?? null);
      },
    );
  }

  async function updateDeck(patch: { title?: string; aspectRatio?: DeckAspectRatio }) {
    await mutate(
      () => api<{ deck: DeckWithPages }>(`/api/decks/${deck.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
      (data) => setDeck(data.deck),
    );
  }

  async function reorder(requested: string[]) {
    if (requested.join("|") === pageIds.join("|")) return;
    await mutate(
      () => api<{ deck: DeckWithPages }>(`/api/decks/${deck.id}/pages/reorder`, {
        method: "POST",
        body: JSON.stringify({ pageIds: requested }),
      }),
      (data) => setDeck(data.deck),
    );
  }

  async function setRecordingBaseline() {
    await flushEditor();
    await mutate(
      () => api<{ baseline: RecordingBaseline }>(`/api/decks/${deck.id}/baseline`, {
        method: "POST",
        body: JSON.stringify({ deckLease: deckLeaseCredentials }),
      }),
      (data) => setBaseline(data.baseline),
    );
  }

  async function resetBaseline(scope: "current" | "all") {
    if (!baseline) return;
    if (scope === "current" && !activePage) return;
    const now = Date.now();
    if (
      !baselineResetArmed
      || baselineResetArmed.scope !== scope
      || !isConfirmedDoubleTap(baselineResetArmed.at, now)
    ) {
      setBaselineResetArmed({ scope, at: now });
      return;
    }
    setBaselineResetArmed(null);
    await flushEditor(true);
    await mutate(
      () => api<{ result: { restoredPageIds: string[]; skippedPageIds: string[] } }>(`/api/decks/${deck.id}/baseline/reset`, {
        method: "POST",
        body: JSON.stringify(scope === "all"
          ? { scope: "all", deckLease: deckLeaseCredentials }
          : { scope: "current", pageId: activePage!.id, deckLease: deckLeaseCredentials }),
      }),
      (data) => {
        void refreshDeck();
        if (data.result.skippedPageIds.length > 0) {
          setError(`${data.result.skippedPageIds.length} baseline page(s) no longer exist and were skipped.`);
        }
      },
    );
    setEditorRevision((value) => value + 1);
  }

  async function createSnapshot() {
    if (!activePage) return;
    await flushEditor();
    const name = window.prompt("Snapshot name", "Clean")?.trim();
    if (!name) return;
    await mutate(
      () => api<{ snapshot: NamedSnapshot }>(`/api/decks/${deck.id}/pages/${activePage.id}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ name, deckLease: deckLeaseCredentials }),
      }),
      (data) => setSnapshots((current) => [data.snapshot, ...current]),
    );
  }

  async function removeSnapshot(snapshot: NamedSnapshot) {
    if (!activePage || !window.confirm(`Delete snapshot "${snapshot.name}"?`)) return;
    await mutate(
      () => api<{ ok: true }>(`/api/decks/${deck.id}/pages/${activePage.id}/snapshots/${snapshot.id}`, {
        method: "DELETE",
        body: JSON.stringify({ deckLease: deckLeaseCredentials }),
      }),
      () => setSnapshots((current) => current.filter((item) => item.id !== snapshot.id)),
    );
  }

  async function selectPage(pageId: string) {
    if (pageId === activePage?.id) return;
    await flushEditor();
    setActivePageId(pageId);
  }

  function dropBefore(targetId: string) {
    if (!draggingPageId || draggingPageId === targetId) return setDraggingPageId(null);
    const ids = pageIds.filter((id) => id !== draggingPageId);
    const index = ids.indexOf(targetId);
    ids.splice(index, 0, draggingPageId);
    setDraggingPageId(null);
    void reorder(ids);
  }

  async function moveActive(direction: "previous" | "next") {
    await flushEditor();
    setActivePageId(movePageId(pageIds, activePage?.id ?? null, direction));
  }

  function movePageBy(pageId: string, delta: -1 | 1) {
    const index = pageIds.indexOf(pageId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= pageIds.length) return;
    const ids = [...pageIds];
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void reorder(ids);
  }


  useEffect(() => {
    if (!baselineResetArmed) return;
    const timer = setTimeout(() => setBaselineResetArmed(null), 2_000);
    return () => clearTimeout(timer);
  }, [baselineResetArmed]);

  useEffect(() => {
    setBaselineResetArmed(null);
  }, [activePageId]);

  const renderSnapshotItems = () => (
    <div className="space-y-2">
      <button onClick={createSnapshot} disabled={busy || !activePage} className="w-full text-xs border rounded px-2 py-1.5 bg-white disabled:opacity-50">+ Save Snapshot</button>
      {snapshots.length === 0 ? (
        <div className="text-xs text-slate-400 px-1">None</div>
      ) : snapshots.map((snapshot) => (
        <div key={snapshot.id} className="flex items-center gap-1 border rounded px-2 py-1 text-xs bg-white">
          <span className="truncate flex-1">{snapshot.name}</span>
          <button onClick={() => removeSnapshot(snapshot)} disabled={busy} aria-label={`Delete ${snapshot.name}`} className="text-slate-400 hover:text-red-600 px-1 disabled:opacity-50">×</button>
        </div>
      ))}
    </div>
  );

  const renderLaserSettings = (side: "right" | "bottom" = "right") => (
    <details className="relative">
      <summary className="list-none cursor-pointer border rounded px-2 py-1.5 text-xs bg-white whitespace-nowrap">Laser Settings</summary>
      <div className={`absolute z-40 w-80 rounded-lg border bg-white shadow-xl p-4 space-y-3 text-sm ${side === "right" ? "right-full top-0 mr-2" : "right-0 bottom-full mb-2"}`}>
        <div className="font-semibold">Laser Settings</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">Trail color<input aria-label="Trail color" type="color" value={laserSettings.trail.color} onChange={(e) => updateLaserSettings({ trail: { color: e.target.value } })} className="w-full h-9" /></label>
          <label className="space-y-1">Dot color<input aria-label="Dot color" type="color" value={laserSettings.dot.color} onChange={(e) => updateLaserSettings({ dot: { color: e.target.value } })} className="w-full h-9" /></label>
        </div>
        <label className="block">Trail size <span className="tabular-nums">{laserSettings.trail.coreSize}px</span><input type="range" min="2" max="32" value={laserSettings.trail.coreSize} onChange={(e) => updateLaserSettings({ trail: { coreSize: Number(e.target.value) } })} className="w-full" /></label>
        <label className="block">Trail glow <span className="tabular-nums">{laserSettings.trail.glowSize}px</span><input type="range" min="0" max="64" value={laserSettings.trail.glowSize} onChange={(e) => updateLaserSettings({ trail: { glowSize: Number(e.target.value) } })} className="w-full" /></label>
        <label className="block">Trail length <span className="tabular-nums">{laserSettings.trail.length}</span><input type="range" min="5" max="200" value={laserSettings.trail.length} onChange={(e) => updateLaserSettings({ trail: { length: Number(e.target.value) } })} className="w-full" /></label>
        <label className="block">Trail decay <span className="tabular-nums">{laserSettings.trail.decayMs}ms</span><input type="range" min="100" max="5000" step="50" value={laserSettings.trail.decayMs} onChange={(e) => updateLaserSettings({ trail: { decayMs: Number(e.target.value) } })} className="w-full" /></label>
        <label className="block">Dot size <span className="tabular-nums">{laserSettings.dot.size}px</span><input type="range" min="2" max="32" value={laserSettings.dot.size} onChange={(e) => updateLaserSettings({ dot: { size: Number(e.target.value) } })} className="w-full" /></label>
        <label className="block">Dot glow <span className="tabular-nums">{laserSettings.dot.glowSize}px</span><input type="range" min="0" max="64" value={laserSettings.dot.glowSize} onChange={(e) => updateLaserSettings({ dot: { glowSize: Number(e.target.value) } })} className="w-full" /></label>
      </div>
    </details>
  );

  const renderPageCards = () => (
    <>
      <div className="space-y-2">
        {deck.pages.map((page, index) => {
          const thumb = page.thumbnailPath
            ? `/api/thumbnails/${page.thumbnailPath.replace(/^thumbnails[\\/]/, "").replace(/\\/g, "/")}`
            : null;
          return (
            <div
              key={page.id}
              draggable
              onDragStart={() => setDraggingPageId(page.id)}
              onDragEnd={() => setDraggingPageId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropBefore(page.id)}
              className={`rounded-lg border p-2 bg-white ${activePage?.id === page.id ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"}`}
            >
              <button onClick={() => void selectPage(page.id)} className="w-full text-left">
                <div className={`${deck.aspectRatio === "16:9" ? "aspect-video" : "aspect-[9/16] max-h-32"} bg-slate-100 rounded overflow-hidden flex items-center justify-center mx-auto`}>
                  {thumb ? <img src={thumb} alt="" className="w-full h-full object-contain" /> : <span className="text-xs text-slate-400">Blank</span>}
                </div>
                <div className="mt-1 text-xs font-medium truncate">{index + 1}. {page.title}</div>
              </button>
              <div className="flex justify-end gap-1 mt-1">
                <button aria-label="Move page up" disabled={index === 0 || busy} onClick={() => movePageBy(page.id, -1)} className="text-xs border rounded px-1.5 disabled:opacity-30">↑</button>
                <button aria-label="Move page down" disabled={index === deck.pages.length - 1 || busy} onClick={() => movePageBy(page.id, 1)} className="text-xs border rounded px-1.5 disabled:opacity-30">↓</button>
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={createBlank} disabled={busy} className="mt-3 w-full border-2 border-dashed border-slate-300 rounded-lg py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">+ Blank page</button>
    </>
  );

  const renderEditor = () => activePage && deckLeaseStatus === "active" && externalDeckLease ? (
    <EmbeddedPageEditor
      key={`${activePage.documentId}:${editorRevision}`}
      documentId={activePage.documentId}
      user={initialUser}
      onSaved={() => void refreshDeck()}
      controlRef={editorControlRef}
      recordingFrameAspectRatio={deck.aspectRatio}
      externalDeckLease={externalDeckLease}
      toolbarOrientation={editorChrome.toolbar}
    />
  ) : (
    <div className="w-full h-full flex flex-col gap-3 items-center justify-center text-slate-500">
      <span>{deckLeaseStatus === "acquiring" ? "Acquiring Deck edit lease..." : deckLeaseStatus === "blocked" ? "This Deck is open in another editing session." : activePage ? "Deck editing is unavailable." : "Add a page to start."}</span>
      {deckLeaseStatus === "blocked" && (
        <button type="button" disabled={takeoverBusy} onClick={() => void takeOverDeck()} className="rounded bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50">
          {takeoverBusy ? "Taking Over..." : "Take Over"}
        </button>
      )}
    </div>
  );

  const navigation = (
    <div className="flex items-center justify-center gap-2">
      <button aria-label="Previous page" disabled={!activePage || activePage.order === 0} onClick={() => void moveActive("previous")} className="border rounded px-2 py-1.5 text-xs bg-white disabled:opacity-40">← Previous</button>
      <span className="text-xs text-slate-500 min-w-14 text-center tabular-nums">{activePage ? `${activePage.order + 1} / ${deck.pages.length}` : "0 / 0"}</span>
      <button aria-label="Next page" disabled={!activePage || activePage.order === deck.pages.length - 1} onClick={() => void moveActive("next")} className="border rounded px-2 py-1.5 text-xs bg-white disabled:opacity-40">Next →</button>
    </div>
  );

  return (
    <div className={`h-screen overflow-hidden bg-slate-100 flex flex-col ${editorChrome.layout === "portrait" ? "deck-editor-portrait" : "deck-editor-landscape"}`}>
      <header className="h-12 shrink-0 bg-white border-b px-3 flex items-center gap-2">
        <Link href="/dashboard" className="text-xs text-slate-500 hover:text-slate-900 whitespace-nowrap">← Dashboard</Link>
        <button
          className="font-semibold truncate max-w-xs text-left hover:bg-slate-100 rounded px-2 py-1 text-sm"
          onClick={() => {
            const title = window.prompt("Deck title", deck.title)?.trim();
            if (title && title !== deck.title) void updateDeck({ title });
          }}
        >{deck.title}</button>
        <select value={deck.aspectRatio} disabled={busy} onChange={(event) => void updateDeck({ aspectRatio: event.target.value as DeckAspectRatio })} className="border rounded px-2 py-1 text-xs bg-white">
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
        </select>
        <span className="hidden xl:inline text-[11px] text-slate-400 truncate">{baseline ? `Baseline ${new Date(baseline.createdAt).toLocaleString()}` : "No recording baseline"}</span>
        {editorChrome.layout === "landscape" && (
          <details className="relative ml-auto">
            <summary className="list-none cursor-pointer border rounded px-2 py-1.5 text-xs bg-white">Actions</summary>
            <div className="absolute right-0 top-full mt-2 z-40 w-56 rounded-lg border bg-white shadow-xl p-2 grid gap-1 text-xs">
              <button disabled={busy} onClick={setRecordingBaseline} className="border rounded px-2 py-1.5 text-left disabled:opacity-50">Set Baseline</button>
              <button disabled={busy || !baseline || !activePage} onClick={() => resetBaseline("current")} className={`border rounded px-2 py-1.5 text-left disabled:opacity-50 ${baselineResetArmed?.scope === "current" ? "border-amber-500 bg-amber-50" : ""}`}>{baselineResetArmed?.scope === "current" ? "Tap Again: Reset Current" : "Reset Current"}</button>
              <button disabled={busy || !baseline} onClick={() => resetBaseline("all")} className={`border rounded px-2 py-1.5 text-left disabled:opacity-50 ${baselineResetArmed?.scope === "all" ? "border-amber-500 bg-amber-50" : ""}`}>{baselineResetArmed?.scope === "all" ? "Tap Again: Reset All" : "Reset All"}</button>
              <button disabled={busy || !activePage} onClick={() => editorControlRef.current?.resetView()} className="border rounded px-2 py-1.5 text-left disabled:opacity-50">Reset View</button>
              <button disabled={busy || !activePage} onClick={duplicateActive} className="border rounded px-2 py-1.5 text-left disabled:opacity-50">Duplicate</button>
              <button disabled={busy || !activePage} onClick={renameActive} className="border rounded px-2 py-1.5 text-left disabled:opacity-50">Rename</button>
              <button disabled={busy || !activePage} onClick={deleteActive} className="border border-red-200 text-red-700 rounded px-2 py-1.5 text-left disabled:opacity-50">Delete</button>
            </div>
          </details>
        )}
        <button disabled={busy || deckLeaseStatus !== "active"} onClick={() => void enterPresent()} className={`${editorChrome.layout === "portrait" ? "ml-auto" : ""} rounded px-3 py-1.5 text-xs bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50`}>{busy ? "Saving..." : "Present"}</button>
      </header>

      {error && <div className="shrink-0 bg-red-50 text-red-700 border-b border-red-200 px-3 py-1.5 text-xs">{error}</div>}

      {editorChrome.layout === "portrait" ? (
        <div className="flex flex-1 min-h-0">
          <aside className="portrait-page-rail w-44 shrink-0 bg-white border-r p-2 flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">{renderPageCards()}</div>
            <div className="shrink-0 border-t mt-2 pt-2 space-y-1">
              <button aria-label="Previous page" disabled={!activePage || activePage.order === 0} onClick={() => void moveActive("previous")} className="w-full border rounded px-2 py-1 text-xs bg-white disabled:opacity-40">↑ Previous</button>
              <div className="text-center text-xs text-slate-500 tabular-nums">{activePage ? `${activePage.order + 1} / ${deck.pages.length}` : "0 / 0"}</div>
              <button aria-label="Next page" disabled={!activePage || activePage.order === deck.pages.length - 1} onClick={() => void moveActive("next")} className="w-full border rounded px-2 py-1 text-xs bg-white disabled:opacity-40">Next ↓</button>
            </div>
          </aside>

          <main className="flex-1 min-w-0 min-h-0 bg-slate-200">{renderEditor()}</main>

          <aside className="portrait-utility-rail w-36 shrink-0 bg-white border-l p-2 overflow-y-auto space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 px-1">Page</div>
            <button disabled={busy || !activePage} onClick={() => editorControlRef.current?.resetView()} className="w-full border rounded px-2 py-1.5 text-xs text-left disabled:opacity-50">Reset View</button>
            <button disabled={busy || !activePage} onClick={duplicateActive} className="w-full border rounded px-2 py-1.5 text-xs text-left disabled:opacity-50">Duplicate</button>
            <button disabled={busy || !activePage} onClick={renameActive} className="w-full border rounded px-2 py-1.5 text-xs text-left disabled:opacity-50">Rename</button>
            <button disabled={busy || !activePage} onClick={deleteActive} className="w-full border border-red-200 text-red-700 rounded px-2 py-1.5 text-xs text-left disabled:opacity-50">Delete</button>
            <div className="border-t pt-2 text-[10px] uppercase tracking-wide text-slate-400 px-1">Recording</div>
            <button disabled={busy} onClick={setRecordingBaseline} className="w-full border border-emerald-300 text-emerald-800 rounded px-2 py-1.5 text-xs text-left disabled:opacity-50">Set Baseline</button>
            <button disabled={busy || !baseline || !activePage} onClick={() => resetBaseline("current")} className={`w-full border rounded px-2 py-1.5 text-xs text-left disabled:opacity-50 ${baselineResetArmed?.scope === "current" ? "border-amber-500 bg-amber-50" : ""}`}>{baselineResetArmed?.scope === "current" ? "Tap Again" : "Reset Current"}</button>
            <button disabled={busy || !baseline} onClick={() => resetBaseline("all")} className={`w-full border rounded px-2 py-1.5 text-xs text-left disabled:opacity-50 ${baselineResetArmed?.scope === "all" ? "border-amber-500 bg-amber-50" : ""}`}>{baselineResetArmed?.scope === "all" ? "Tap Again" : "Reset All"}</button>
            <div className="border-t pt-2">{renderLaserSettings("right")}</div>
            <details className="border-t pt-2">
              <summary className="cursor-pointer list-none border rounded px-2 py-1.5 text-xs bg-white">Snapshots ({snapshots.length})</summary>
              <div className="mt-2">{renderSnapshotItems()}</div>
            </details>
          </aside>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <aside className="w-52 shrink-0 bg-white border-r p-2 overflow-y-auto">{renderPageCards()}</aside>
          <main className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex-1 min-h-0 bg-slate-200">{renderEditor()}</div>
            <div className="landscape-bottom-bar h-12 shrink-0 bg-white border-t px-3 flex items-center gap-3">
              {navigation}
              <details className="relative">
                <summary className="list-none cursor-pointer border rounded px-2 py-1.5 text-xs bg-white">Snapshots ({snapshots.length})</summary>
                <div className="absolute left-0 bottom-full mb-2 z-40 w-64 max-h-72 overflow-y-auto rounded-lg border bg-white shadow-xl p-3">{renderSnapshotItems()}</div>
              </details>
              {renderLaserSettings("bottom")}
              <span className="ml-auto text-[11px] text-slate-400 truncate max-w-xs">{activePage?.title ?? "No page"}</span>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
