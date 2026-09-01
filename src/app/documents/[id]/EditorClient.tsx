"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ExcalidrawCanvas from "@/components/ExcalidrawCanvas";
import RecoveryConflictModal from "@/components/RecoveryConflictModal";
import EditLeaseConflictModal from "@/components/EditLeaseConflictModal";
import { api, ApiError } from "@/lib/client";
import {
  saveDocumentScene,
  sceneForLocalDraft,
  serializeSceneForComparison,
  buildCompactClientScene,
  decideDraftForAccess,
  localDraftStorageKey,
  summarizeRecoveryScene,
  resolveClientRecovery,
  sceneMatchesLastSaved,
  getManualSaveStatus,
} from "@/lib/client_save";
import { getLeaseClientId, acquireLease, heartbeatLease, requestTakeover, pollTakeover, releaseLease, canMutateCanvas, shouldReadLocalDraft, waitForNoSaving, shouldRecoverHandoffToActive, shouldSkipHandoffForRestore, credentialKey, dispatchRelease } from "@/lib/client_edit_lease";
import type { EditorLeaseMode } from "@/lib/client_edit_lease";
import type { EditLeaseCredentials, ExcalidrawScene, Permission, LeaseHolderSummary } from "@/lib/types";
import type { LocalDraftEnvelope } from "@/lib/client_save";

interface User {
  id: string;
  username: string;
  role: "USER" | "ADMIN";
  is_active: boolean;
}

interface VersionRow {
  id: string;
  version_number: number;
  thumbnail_path: string | null;
  created_by: string;
  created_by_username?: string;
  created_at: string;
  origin: string | null;
}

interface MemberRow {
  user_id: string;
  username: string;
  permission: Permission;
}

interface ShareLinkInfo {
  token: string;
  url: string;
  permission?: Permission;
  is_active: boolean;
  expires_at: string | null;
}

interface Props {
  user: User;
  docId: string;
  initialTitle: string;
  initialScene: ExcalidrawScene;
  initialUpdatedAt?: string;
  permission: Permission;
  deleted: boolean;
  adminMode?: boolean;
}

interface DraftConflictState {
  draft: LocalDraftEnvelope;
  serverScene: ExcalidrawScene;
  serverUpdatedAt: string;
}

export function originBadgeLabel(origin: string | null | undefined): string {
  switch (origin) {
    case "manual_save":
      return "Manual save";
    case "auto_snapshot":
      return "Auto snapshot";
    case "restore":
      return "Restore";
    case "recovery_client_draft":
      return "Client draft";
    case "recovery_server_version":
      return "Server version";
    default:
      return "Legacy / unknown";
  }
}

const AUTO_SAVE_MS = 3000;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export default function EditorClient({
  user,
  docId,
  initialTitle,
  initialScene,
  initialUpdatedAt,
  permission: initialPermission,
  deleted: initialDeleted,
  adminMode: initialAdminMode = false,
}: Props) {
  const router = useRouter();
  const [currentPermission, setCurrentPermission] = useState<Permission>(initialPermission);
  const [isDeleted, setIsDeleted] = useState(initialDeleted);

  const hasWritePermission = currentPermission !== "VIEWER" && !isDeleted;
  const adminMode = initialAdminMode;
  const withAdminMode = (url: string) => adminMode ? `${url}${url.includes("?") ? "&" : "?"}adminMode=1` : url;
  const hasReleasedRef = useRef<Set<string>>(new Set());
  const bestEffortReleaseOnce = (creds: { clientId: string; leaseToken: string; generation: number } | null) => {
    if (!creds) return;
    const key = credentialKey(creds as EditLeaseCredentials);
    const url = withAdminMode(`/api/documents/${encodeURIComponent(docId)}/lease`);
    const payload = JSON.stringify({ action: "release", clientId: creds.clientId, leaseToken: creds.leaseToken, generation: creds.generation });
    dispatchRelease(url, payload, hasReleasedRef.current, key);
  };
  // lease mode state
  const [leaseMode, setLeaseMode] = useState<"viewer" | "acquiring" | "blocked" | "active" | "handoff" | "readonly" | "lost">(
    hasWritePermission ? "acquiring" : "viewer"
  );
  const [leaseHolder, setLeaseHolder] = useState<LeaseHolderSummary | null>(null);
  const [leaseBusy, setLeaseBusy] = useState(false);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  const leaseModeRef = useRef(leaseMode);
  const leaseCredentialsRef = useRef<EditLeaseCredentials | null>(null);
  const leaseClientIdRef = useRef<string | null>(null);
  const leaseTokenRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handoffGuardRef = useRef(false);
  const heartbeatInFlightRef = useRef(false);
  const takeoverPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const takeoverPollInFlightRef = useRef(false);
  const isRestoringRef = useRef(false);

  useEffect(() => { leaseModeRef.current = leaseMode; }, [leaseMode]);

  const canEditCanvas = canMutateCanvas(leaseMode as unknown as "active" | "viewer" | "blocked" | "readonly" | "handoff" | "lost" | "acquiring");

  const [title, setTitle] = useState(initialTitle);
  const [titleInput, setTitleInput] = useState(initialTitle);
  const [isEditingTitle, setIsEditingTitle] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [statusText, setStatusText] = useState("");

  const sceneRef = useRef<ExcalidrawScene>(initialScene);
  const lastSavedContentRef = useRef<string>(serializeSceneForComparison(initialScene));
  const [initialCanvasScene, setInitialCanvasScene] = useState<ExcalidrawScene>(initialScene);
  const [canvasKey, setCanvasKey] = useState<number>(0);
  const isDirtyRef = useRef(false);
  const persistedFileIdsRef = useRef<Set<string>>(new Set(Object.keys(initialScene.files || {})));
  const isSavingRef = useRef<boolean>(false);
  const queuedSaveRef = useRef<{ forceSnapshot: boolean } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSnapshotRef = useRef<number>(Date.now());
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draftKey = localDraftStorageKey(user.id, docId);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [draftConflict, setDraftConflict] = useState<DraftConflictState | null>(null);
  const [preserveDiscarded, setPreserveDiscarded] = useState(true);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<VersionRow | null>(null);

  const [showShare, setShowShare] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [shareLink, setShareLink] = useState<ShareLinkInfo | null>(null);
  const [shareTab, setShareTab] = useState<"members" | "link" | "transfer">("members");
  const [newMemberUsername, setNewMemberUsername] = useState("");
  const [linkExpiresAt, setLinkExpiresAt] = useState("");
  const [transferUsername, setTransferUsername] = useState("");
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState<string | null>(null);

  const setStatus = useCallback((msg: string, state: "idle" | "saving" | "saved" | "error" = "saved") => {
    setSaving(state);
    setStatusText(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    if (state === "saved" || state === "error") {
      statusTimerRef.current = setTimeout(() => {
        setStatusText("");
        setSaving("idle");
      }, 3000);
    }
  }, []);

  const loadVersions = useCallback(async () => {
    try {
      const data = await api<{ versions: VersionRow[] }>(withAdminMode(`/api/documents/${docId}/versions`));
      setVersions(data.versions);
    } catch {
      // ignore
    }
  }, [docId]);

  const loadShare = useCallback(async () => {
    const isOwner = currentPermission === "OWNER" || user.role === "ADMIN";
    if (!isOwner) return;
    try {
      const [linkData, memberData] = await Promise.all([
        api<{ link: ShareLinkInfo | null }>(withAdminMode(`/api/documents/${docId}/share/link`)),
        api<{ members: MemberRow[] }>(withAdminMode(`/api/documents/${docId}/share/members`)),
      ]);
      setShareLink(linkData.link);
      setMembers(memberData.members);
    } catch {
      // ignore
    }
  }, [docId, currentPermission, user.role]);

  useEffect(() => {
    loadVersions();
    const isOwner = currentPermission === "OWNER" || user.role === "ADMIN";
    if (isOwner) loadShare();
  }, [loadVersions, loadShare, currentPermission]);

  const handleLeaseLost = useCallback(async (isDirty: boolean) => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (takeoverPollRef.current) {
      clearInterval(takeoverPollRef.current);
      takeoverPollRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    handoffGuardRef.current = false;
    leaseCredentialsRef.current = null;
    // Do not clear localStorage draft
    try {
      const data = await api<{ document: { title: string }; scene: ExcalidrawScene; permission: Permission }>(withAdminMode(`/api/documents/${docId}`));
      sceneRef.current = data.scene;
      lastSavedContentRef.current = serializeSceneForComparison(data.scene);
      // isDirtyRef should remain true if dirty? But spec says old editor retains unconfirmed draft, so keep isDirty true
      // Do not clear draft
      setInitialCanvasScene(data.scene);
      setCanvasKey((k) => k + 1);
      setDraftConflict(null);
      setRecoveryReady(true);
    } catch {
      // ignore fetch error
      setRecoveryReady(true);
    }
    if (draftConflict) {
      // If lease lost while recovery modal open, close it without deleting draft
      setDraftConflict(null);
      setRecoveryReady(true);
    }
    setLeaseMode("lost");
    if (isDirty) {
      setStatus("Editing was taken over. Unsaved local changes were kept for recovery.", "error");
    } else {
      setStatus("Editing moved to another screen.", "error");
    }
  }, [docId, draftConflict, setStatus]);

  const finalizeAcquisition = useCallback(async (creds: EditLeaseCredentials) => {
    try {
      const data = await api<{ document: { title: string; updated_at?: string }; scene: ExcalidrawScene }>(withAdminMode(`/api/documents/${docId}`));
      const serverScene = data.scene;
      const serverUpdatedAt = (data.document as unknown as { updated_at?: string }).updated_at || "";
      const decision = decideDraftForAccess(true, () => {
        try { return localStorage.getItem(draftKey); } catch { return null; }
      }, serverScene);
      if (decision.kind === "equal") {
        try { localStorage.removeItem(draftKey); } catch {}
        sceneRef.current = serverScene;
        lastSavedContentRef.current = serializeSceneForComparison(serverScene);
        isDirtyRef.current = false;
        persistedFileIdsRef.current = new Set(Object.keys(serverScene.files || {}));
        setInitialCanvasScene(serverScene);
        setCanvasKey((k) => k + 1);
        setRecoveryReady(true);
        setDraftConflict(null);
      } else if (decision.kind === "conflict") {
        setDraftConflict({ draft: decision.draft, serverScene, serverUpdatedAt });
        setRecoveryReady(false);
      } else {
        if (decision.kind === "malformed") {
          setStatus("Local recovery draft could not be read; server version opened and draft retained.", "error");
        }
        sceneRef.current = serverScene;
        lastSavedContentRef.current = serializeSceneForComparison(serverScene);
        isDirtyRef.current = false;
        persistedFileIdsRef.current = new Set(Object.keys(serverScene.files || {}));
        setInitialCanvasScene(serverScene);
        setCanvasKey((k) => k + 1);
        setRecoveryReady(true);
        setDraftConflict(null);
      }
      setLeaseMode("active");
    } catch (err) {
      try { await releaseLease(docId, creds, undefined, adminMode); } catch {}
      leaseCredentialsRef.current = null;
      sceneRef.current = initialScene;
      lastSavedContentRef.current = serializeSceneForComparison(initialScene);
      persistedFileIdsRef.current = new Set(Object.keys(initialScene.files || {}));
      setInitialCanvasScene(initialScene);
      setCanvasKey((k) => k + 1);
      setLeaseError(err instanceof Error ? err.message : "Failed to load latest document. Please retry takeover.");
      setLeaseMode("readonly");
      setRecoveryReady(true);
    }
  }, [docId, draftKey, initialScene, setStatus]);

  // Initial lease gate
  useEffect(() => {
    if (!hasWritePermission) {
      setLeaseMode("viewer");
      // Viewer: never touch localStorage, fetch server scene read-only (already initialScene is server)
      setRecoveryReady(true);
      // Ensure no draft handling
      return;
    }
    // Writable: acquire lease before editable mount
    let cancelled = false;
    const doAcquire = async () => {
      setLeaseMode("acquiring");
      try {
        const clientId = getLeaseClientId(sessionStorage as unknown as Storage);
        leaseClientIdRef.current = clientId;
        const leaseToken = crypto.randomUUID();
        leaseTokenRef.current = leaseToken;
        const result = await acquireLease(docId, { clientId, leaseToken }, undefined, adminMode);
        if (cancelled) {
          if (result.state === "acquired") {
            bestEffortReleaseOnce({ clientId, leaseToken, generation: result.generation });
          }
          return;
        }
        if (result.state === "acquired") {
          const creds = { clientId, leaseToken, generation: result.generation };
          leaseCredentialsRef.current = creds;
          await finalizeAcquisition(creds);
        } else if (result.state === "held") {
          setLeaseHolder(result.holder);
          setLeaseMode("blocked");
          setRecoveryReady(true);
        }
      } catch (err) {
        sceneRef.current = initialScene;
        lastSavedContentRef.current = serializeSceneForComparison(initialScene);
        persistedFileIdsRef.current = new Set(Object.keys(initialScene.files || {}));
        setInitialCanvasScene(initialScene);
        setCanvasKey((k) => k + 1);
        setLeaseError(err instanceof Error ? err.message : "Failed to acquire lease. Please retry takeover.");
        setLeaseMode("readonly");
        setRecoveryReady(true);
      }
    };
    void doAcquire();
    return () => {
      cancelled = true;
      bestEffortReleaseOnce(leaseCredentialsRef.current);
    };
  }, [docId, hasWritePermission, finalizeAcquisition]);

  const handleOpenReadOnly = useCallback(async () => {
    setLeaseBusy(true);
    setLeaseError(null);
    try {
      const data = await api<{ document: { title: string }; scene: ExcalidrawScene }>(withAdminMode(`/api/documents/${docId}`));
      sceneRef.current = data.scene;
      lastSavedContentRef.current = serializeSceneForComparison(data.scene);
      persistedFileIdsRef.current = new Set(Object.keys(data.scene.files || {}));
      setInitialCanvasScene(data.scene);
      setCanvasKey((k) => k + 1);
      isDirtyRef.current = false;
      setLeaseMode("readonly");
      setRecoveryReady(true);
      setDraftConflict(null);
    } catch (err) {
      setLeaseError(err instanceof Error ? err.message : "Failed to load document");
    } finally {
      setLeaseBusy(false);
    }
  }, [docId]);

  const handleTakeover = useCallback(async () => {
    setLeaseBusy(true);
    setLeaseError(null);
    const clientId = leaseClientIdRef.current || getLeaseClientId(sessionStorage as unknown as Storage);
    leaseClientIdRef.current = clientId;
    const leaseToken = crypto.randomUUID();
    leaseTokenRef.current = leaseToken;
    try {
      const result = await requestTakeover(docId, { clientId, leaseToken }, undefined, adminMode);
      if (result.state === "acquired") {
        const creds = { clientId, leaseToken, generation: result.generation };
        leaseCredentialsRef.current = creds;
        await finalizeAcquisition(creds);
        setLeaseBusy(false);
        return;
      }
      if (result.state === "takeover_pending") {
        const requestId = result.requestId;
        // Poll every 1s until acquired
        if (takeoverPollRef.current) clearInterval(takeoverPollRef.current);
        takeoverPollInFlightRef.current = false;
        takeoverPollRef.current = setInterval(async () => {
          if (takeoverPollInFlightRef.current) return;
          takeoverPollInFlightRef.current = true;
          try {
            const pollRes = await pollTakeover(docId, { clientId, leaseToken, requestId }, undefined, adminMode);
            if (pollRes.state === "acquired") {
              if (takeoverPollRef.current) { clearInterval(takeoverPollRef.current); takeoverPollRef.current = null; }
              const creds = { clientId, leaseToken, generation: pollRes.generation };
              leaseCredentialsRef.current = creds;
              await finalizeAcquisition(creds);
              setLeaseBusy(false);
            } else if (pollRes.state === "takeover_pending") {
              // still waiting
            } else if ((pollRes as { state: string }).state === "takeover_in_progress") {
              setLeaseError("Another takeover is in progress. Please try again.");
              if (takeoverPollRef.current) { clearInterval(takeoverPollRef.current); takeoverPollRef.current = null; }
              setLeaseBusy(false);
            } else if ((pollRes as { state: string }).state === "held") {
              setLeaseError("Takeover failed. Please retry.");
              if (takeoverPollRef.current) { clearInterval(takeoverPollRef.current); takeoverPollRef.current = null; }
              setLeaseBusy(false);
            }
          } catch (err) {
            if (err instanceof ApiError && err.code === "EDIT_LEASE_LOST") {
              setLeaseError("Takeover failed. Please retry.");
              if (takeoverPollRef.current) { clearInterval(takeoverPollRef.current); takeoverPollRef.current = null; }
              setLeaseBusy(false);
            } else if (err instanceof ApiError && err.code === "TAKEOVER_IN_PROGRESS") {
              setLeaseError("Another takeover is in progress. Please try again.");
              if (takeoverPollRef.current) { clearInterval(takeoverPollRef.current); takeoverPollRef.current = null; }
              setLeaseBusy(false);
            } else {
              setLeaseError(err instanceof Error ? err.message : "Takeover failed. Please retry.");
              if (takeoverPollRef.current) { clearInterval(takeoverPollRef.current); takeoverPollRef.current = null; }
              setLeaseBusy(false);
            }
          } finally {
            takeoverPollInFlightRef.current = false;
          }
        }, 1000);
        return;
      }
      if ((result as { state: string }).state === "takeover_in_progress") {
        setLeaseError("Another takeover is in progress. Please try again.");
        setLeaseBusy(false);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "TAKEOVER_IN_PROGRESS") {
        setLeaseError("Another takeover is in progress. Please try again.");
      } else {
        setLeaseError(err instanceof Error ? err.message : "Takeover failed");
      }
      setLeaseBusy(false);
    }
  }, [docId, draftKey]);

  // Heartbeat and graceful handoff with serialization and bounded status checking
  useEffect(() => {
    if (leaseMode !== "active" && leaseMode !== "handoff") return;
    const creds = leaseCredentialsRef.current;
    if (!creds) return;
    if (heartbeatTimerRef.current) return;
    heartbeatTimerRef.current = setInterval(async () => {
      if (heartbeatInFlightRef.current) return;
      heartbeatInFlightRef.current = true;
      try {
        const res = await heartbeatLease(docId, creds, undefined, adminMode);
        if (res.state === "takeover_pending") {
          if (shouldSkipHandoffForRestore(isRestoringRef.current, res.state)) return;
          if (handoffGuardRef.current) return;
          handoffGuardRef.current = true;
          setLeaseMode("handoff");
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          try {
            await waitForNoSaving(isSavingRef);
            await saveDocumentScene({
              docId,
              scene: sceneRef.current,
              persistedFileIds: persistedFileIdsRef.current,
              isManualSave: false,
              snapshotDue: false,
              lease: creds,
              adminMode,
            });
            await releaseLease(docId, creds, undefined, adminMode);
            const data = await api<{ document: { title: string }; scene: ExcalidrawScene }>(withAdminMode(`/api/documents/${docId}`));
            sceneRef.current = data.scene;
            lastSavedContentRef.current = serializeSceneForComparison(data.scene);
            persistedFileIdsRef.current = new Set(Object.keys(data.scene.files || {}));
            setInitialCanvasScene(data.scene);
            setCanvasKey((k) => k + 1);
            isDirtyRef.current = false;
            try { localStorage.removeItem(draftKey); } catch {}
            setLeaseMode("readonly");
            leaseCredentialsRef.current = null;
            if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
          } catch (e) {
            if (e instanceof ApiError && e.code === "EDIT_LEASE_LOST") {
              const isDirty = isDirtyRef.current;
              void handleLeaseLost(isDirty);
            } else {
              setStatus("Failed to flush changes for handover; will retry until takeover completes.", "error");
            }
          } finally {
            handoffGuardRef.current = false;
          }
        } else if (shouldRecoverHandoffToActive(leaseModeRef.current as EditorLeaseMode, res.state)) {
          setLeaseMode("active");
          handoffGuardRef.current = false;
        }
      } catch (err) {
        if (err instanceof ApiError && (err.code === "EDIT_LEASE_LOST" || err.status === 403)) {
          const isDirty = isDirtyRef.current;
          void handleLeaseLost(isDirty);
          handoffGuardRef.current = false;
        }
      } finally {
        heartbeatInFlightRef.current = false;
      }
    }, 2000);
    return () => {
      // Do not clear on handoff; only clear when leaving active/handoff to readonly/lost/blocked
    };
  }, [leaseMode, docId, draftKey, handleLeaseLost, setStatus]);

  useEffect(() => {
    if (leaseMode !== "active" && leaseMode !== "handoff") {
      if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
      handoffGuardRef.current = false;
    }
  }, [leaseMode]);


  const handleLeaseLostForMutation = useCallback(async (err: unknown) => {
    if (err instanceof ApiError && err.code === "EDIT_LEASE_LOST") {
      const isDirty = isDirtyRef.current;
      await handleLeaseLost(isDirty);
      return true;
    }
    return false;
  }, [handleLeaseLost]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (takeoverPollRef.current) clearInterval(takeoverPollRef.current);
      bestEffortReleaseOnce(leaseCredentialsRef.current);
    };
  }, [docId]);

  const executeSave = useCallback(
    async (forceSnapshot: boolean) => {
      if (isRestoringRef.current || !canEditCanvas || (!isDirtyRef.current && !forceSnapshot)) return;
      if (isSavingRef.current) {
        queuedSaveRef.current = {
          forceSnapshot: forceSnapshot || queuedSaveRef.current?.forceSnapshot || false,
        };
        return;
      }

      isSavingRef.current = true;
      setStatus(forceSnapshot ? "Saving snapshot..." : "Saving...", "saving");

      try {
        let currentSnapshot = forceSnapshot;
        let lastResult: Awaited<ReturnType<typeof saveDocumentScene>> | null = null;
        while (true) {
          const snapshotBeforeSave = sceneRef.current;
          const serializedBeforeSave = serializeSceneForComparison(snapshotBeforeSave);
          const creds = leaseCredentialsRef.current;
          if (!creds) {
            throw new ApiError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
          }

          const res = await saveDocumentScene({
            docId,
            scene: snapshotBeforeSave,
            persistedFileIds: persistedFileIdsRef.current,
            isManualSave: currentSnapshot,
            snapshotDue: currentSnapshot,
            lease: creds,
            adminMode,
          });
          lastResult = res;

          // Check if user edited scene during in-flight save
          const currentSerialized = serializeSceneForComparison(sceneRef.current);
          if (currentSerialized === serializedBeforeSave) {
            lastSavedContentRef.current = serializedBeforeSave;
            isDirtyRef.current = false;
            try {
              localStorage.removeItem(draftKey);
            } catch {
              // ignore
            }
          } else {
            // Edits occurred while saving! Retain dirty state and keep localStorage draft
            lastSavedContentRef.current = serializedBeforeSave;
            isDirtyRef.current = true;
          }

          if (res.snapshotCreated) {
            lastSnapshotRef.current = Date.now();
            await loadVersions();
          } else if (currentSnapshot && res.alreadySaved) {
            // No new snapshot, but manual save was acknowledged
            await loadVersions();
          }

          if (queuedSaveRef.current || isDirtyRef.current) {
            currentSnapshot = queuedSaveRef.current?.forceSnapshot || false;
            queuedSaveRef.current = null;
          } else {
            queuedSaveRef.current = null;
            break;
          }
        }

        if (lastResult && forceSnapshot) {
          const manualStatus = getManualSaveStatus(lastResult);
          if (manualStatus === "Already saved" || manualStatus === "Snapshot saved") {
            setStatus(manualStatus, "saved");
          } else {
            setStatus(`Saved ${new Date().toLocaleTimeString()}`, "saved");
          }
        } else {
          setStatus(`Saved ${new Date().toLocaleTimeString()}`, "saved");
        }
      } catch (err) {
        queuedSaveRef.current = null;
        if (await handleLeaseLostForMutation(err)) return;
        setStatus(err instanceof Error ? err.message : "Save failed", "error");
      } finally {
        isSavingRef.current = false;
      }
    },
    [canEditCanvas, docId, draftKey, loadVersions, setStatus, handleLeaseLostForMutation],
  );

  const saveNow = useCallback(
    async (forceSnapshot: boolean) => {
      await executeSave(forceSnapshot);
    },
    [executeSave],
  );

  const handleChange = useCallback(
    (s: ExcalidrawScene) => {
      if (!canEditCanvas || isRestoringRef.current) return;

      // Keep the latest in-memory files (hydrated dataURLs) even when not dirty,
      // so thumbnail exportToBlob can rasterize images.
      sceneRef.current = s;

      if (sceneMatchesLastSaved(s, lastSavedContentRef.current)) {
        isDirtyRef.current = false;
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // Browser storage may be unavailable; the scene is still clean in memory.
        }
        return;
      }

      isDirtyRef.current = true;

      // 1. Immediately cache in localStorage with timestamp.
      // Persisted images stay compact so reload uses /api/attachments instead of draft base64.
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            scene: sceneForLocalDraft(s, persistedFileIdsRef.current),
            updatedAt: Date.now(),
          }),
        );
      } catch {
        setStatus("Local recovery draft could not be saved; keep this tab open until server save completes.", "error");
      }

      // 2. Debounce auto-save to server
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const due = Date.now() - lastSnapshotRef.current >= SNAPSHOT_INTERVAL_MS;
        void saveNow(due);
      }, AUTO_SAVE_MS);
    },
    [canEditCanvas, draftKey, saveNow, setStatus],
  );

  const manualSave = useCallback(async () => {
    if (isRestoringRef.current || !canEditCanvas) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    await executeSave(true);
  }, [canEditCanvas, executeSave]);

  // Intercept Ctrl+S / Cmd+S globally to save immediately to server
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        if (canEditCanvas) {
          void manualSave();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [canEditCanvas, manualSave]);

  // S3 crash-save beacon: on beforeunload, send a keepalive PUT with compact scene if dirty and canEdit
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!canEditCanvas || !isDirtyRef.current || !sceneRef.current) return;
      const creds = leaseCredentialsRef.current;
      if (!creds) return;
      const compactScene = buildCompactClientScene(sceneRef.current);
      const base = typeof window !== "undefined" && window.location ? window.location.origin : "";
      const url = withAdminMode(`${base}/api/documents/${encodeURIComponent(docId)}/scene`);
      try {
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scene: compactScene, lease: creds }),
          credentials: "include",
          keepalive: true,
        });
      } catch {
        // ignore
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [canEditCanvas, docId]);

  useEffect(() => {
    const handlePageHide = () => {
      bestEffortReleaseOnce(leaseCredentialsRef.current);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [docId]);

  const resolveDraftChoice = useCallback(
    async (choice: "client" | "server") => {
      if (!draftConflict || recoveryBusy) return;
      setRecoveryBusy(true);
      setRecoveryError(null);
      try {
        const creds = leaseCredentialsRef.current;
        if (!creds) throw new ApiError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
        const result = await resolveClientRecovery({
          docId,
          choice,
          preserveDiscarded,
          expectedServerUpdatedAt: draftConflict.serverUpdatedAt,
          draft: draftConflict.draft,
          persistedFileIds: persistedFileIdsRef.current,
          lease: creds,
          adminMode,
        });
        if (!result.ok) {
          setDraftConflict((current) =>
            current
              ? {
                  ...current,
                  serverScene: result.serverScene,
                  serverUpdatedAt: result.serverUpdatedAt,
                }
              : current,
          );
          setRecoveryError("The server version changed. Compare the latest server version and choose again.");
          return;
        }

        const selected = choice === "client" ? draftConflict.draft.scene : draftConflict.serverScene;
        try { localStorage.removeItem(draftKey); } catch {}
        sceneRef.current = selected;
        lastSavedContentRef.current = serializeSceneForComparison(selected);
        isDirtyRef.current = false;
        persistedFileIdsRef.current = new Set(Object.keys(selected.files || {}));
        setInitialCanvasScene(selected);
        setCanvasKey((key) => key + 1);
        setDraftConflict(null);
        setRecoveryReady(true);
        if (result.snapshotCreated) await loadVersions();
        setStatus(choice === "client" ? "Client draft restored" : "Server version selected", "saved");
      } catch (error) {
        if (await handleLeaseLostForMutation(error)) return;
        setRecoveryError(error instanceof Error ? error.message : "Recovery failed");
      } finally {
        setRecoveryBusy(false);
      }
    },
    [draftConflict, recoveryBusy, docId, draftKey, preserveDiscarded, loadVersions, setStatus, handleLeaseLostForMutation],
  );

  // If lease lost while recovery modal open, close it
  useEffect(() => {
    if ((leaseMode === "lost" || leaseMode === "readonly") && draftConflict) {
      // Spec: If the lease is lost while the recovery modal is open, close the recovery flow without deleting the draft, load latest server scene, and enter read-only mode.
      // Already handled by handleLeaseLost which clears draftConflict, but ensure isDirty retained
      // Do not clear draftKey
      setDraftConflict(null);
      setRecoveryReady(true);
    }
  }, [leaseMode, draftConflict]);

  async function saveTitle() {
    setIsEditingTitle(false);
    const trimmed = titleInput.trim();
    if (!trimmed || trimmed === title || !hasWritePermission) {
      setTitleInput(title);
      return;
    }
    try {
      const res = await api<{ document: { title: string } }>(withAdminMode(`/api/documents/${docId}`), {
        method: "PATCH",
        body: JSON.stringify({ title: trimmed }),
      });
      setTitle(res.document.title);
      setTitleInput(res.document.title);
    } catch (err) {
      setTitleInput(title);
      alert(err instanceof Error ? err.message : "Failed to rename document");
    }
  }

  async function restoreVersion(versionId: string) {
    if (!canEditCanvas || isRestoringRef.current) return;
    if (!confirm("Restore this version? A snapshot of the current state will be saved before restoring.")) {
      return;
    }
    isRestoringRef.current = true;
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    try {
      await waitForNoSaving(isSavingRef);
      const creds = leaseCredentialsRef.current;
      if (!creds) throw new ApiError(409, "Editing lease was lost", "EDIT_LEASE_LOST");
      setStatus("Restoring version...", "saving");
      await api(withAdminMode(`/api/documents/${docId}/versions?action=restore&versionId=${versionId}`), {
        method: "POST",
        body: JSON.stringify({ lease: creds }),
      });
      const data = await api<{ document: { title: string }; scene: ExcalidrawScene; permission: Permission }>(withAdminMode(`/api/documents/${docId}`));
      sceneRef.current = data.scene;
      lastSavedContentRef.current = serializeSceneForComparison(data.scene);
      isDirtyRef.current = false;
      persistedFileIdsRef.current = new Set(Object.keys(data.scene.files || {}));
      try { localStorage.removeItem(draftKey); } catch {}
      setInitialCanvasScene(data.scene);
      setCanvasKey((k) => k + 1);
      setTitle(data.document.title);
      setTitleInput(data.document.title);
      await loadVersions();
      setShowVersions(false);
      setStatus(`Restored version successfully`, "saved");
    } catch (err) {
      if (await handleLeaseLostForMutation(err)) return;
      setStatus(err instanceof Error ? err.message : "Failed to restore version", "error");
    } finally {
      isRestoringRef.current = false;
    }
  }

  async function deleteDoc() {
    if (!confirm("Move this document to Trash?")) return;
    try {
      await api(withAdminMode(`/api/documents/${docId}`), { method: "DELETE" });
      router.push("/dashboard");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete document");
    }
  }

  // Share handlers
  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setShareError(null);
    setShareSuccess(null);
    if (!newMemberUsername.trim()) return;
    try {
      const res = await api<{ members: MemberRow[] }>(withAdminMode(`/api/documents/${docId}/share/members`), {
        method: "POST",
        body: JSON.stringify({ username: newMemberUsername.trim() }),
      });
      setMembers(res.members);
      setNewMemberUsername("");
      setShareSuccess(`Shared with @${newMemberUsername.trim()}`);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to share");
    }
  }

  async function removeMember(userId: string) {
    setShareError(null);
    setShareSuccess(null);
    try {
      const res = await api<{ members: MemberRow[] }>(withAdminMode(`/api/documents/${docId}/share/members?userId=${userId}`),
        { method: "DELETE" },
      );
      setMembers(res.members);
      setShareSuccess("Removed user permission");
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  async function createOrUpdateLink() {
    setShareError(null);
    setShareSuccess(null);
    try {
      const res = await api<{ link: ShareLinkInfo }>(withAdminMode(`/api/documents/${docId}/share/link`), {
        method: "POST",
        body: JSON.stringify({ expiresAt: linkExpiresAt || null }),
      });
      setShareLink(res.link);
      setShareSuccess("Public share link created/updated");
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to create share link");
    }
  }

  async function deactivateLink() {
    setShareError(null);
    setShareSuccess(null);
    try {
      await api(withAdminMode(`/api/documents/${docId}/share/link`), { method: "DELETE" });
      setShareLink(null);
      setShareSuccess("Share link deactivated");
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to deactivate share link");
    }
  }

  async function transferDocOwnership(e: React.FormEvent) {
    e.preventDefault();
    setShareError(null);
    setShareSuccess(null);
    const target = transferUsername.trim();
    if (!target) return;
    if (
      !confirm(
        `Are you sure you want to transfer ownership to ${target}? You will become an EDITOR.`,
      )
    ) {
      return;
    }
    try {
      await api(withAdminMode(`/api/documents/${docId}/transfer`), {
        method: "POST",
        body: JSON.stringify({ username: target }),
      });
      setCurrentPermission("EDITOR");
      setTransferUsername("");
      setShareSuccess(`Ownership successfully transferred to ${target}`);
      await loadShare();
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to transfer ownership");
    }
  }

  function copyLinkUrl() {
    if (!shareLink) return;
    const fullUrl = window.location.origin + shareLink.url;
    navigator.clipboard.writeText(fullUrl).then(
      () => setShareSuccess("Share link copied to clipboard!"),
      () => setShareError("Failed to copy link"),
    );
  }

  const isReadOnlyBanner = (leaseMode === "readonly" || leaseMode === "lost") && hasWritePermission;
  const showLeaseConflict = leaseMode === "blocked";
  const showCanvas = (() => {
    if (leaseMode === "viewer") return true;
    if (leaseMode === "active" || leaseMode === "handoff") return recoveryReady && !draftConflict;
    if (leaseMode === "readonly" || leaseMode === "lost") return true;
    if (leaseMode === "blocked") return false;
    if (leaseMode === "acquiring") return false;
    return recoveryReady && !draftConflict;
  })();

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Top Navigation Bar */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-white border-b shadow-sm z-10 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/dashboard"
            className="text-gray-600 hover:text-gray-900 text-sm font-medium flex items-center gap-1 shrink-0"
          >
            ← Dashboard
          </Link>

          <span className="text-gray-300">|</span>

          {/* Title Editor */}
          {hasWritePermission ? (
            isEditingTitle ? (
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") {
                    setTitleInput(title);
                    setIsEditingTitle(false);
                  }
                }}
                autoFocus
                className="font-semibold text-base px-2 py-0.5 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-xs"
              />
            ) : (
              <button
                onClick={() => setIsEditingTitle(true)}
                className="font-semibold text-base text-gray-800 hover:bg-gray-100 px-2 py-0.5 rounded truncate max-w-xs text-left"
                title="Click to rename"
              >
                {title}
              </button>
            )
          ) : (
            <span className="font-semibold text-base text-gray-800 truncate max-w-xs">{title}</span>
          )}

          {/* Status Indicators */}
          {!hasWritePermission && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium shrink-0">
              {isDeleted ? "In Trash" : "Read-only"}
            </span>
          )}
          {hasWritePermission && (leaseMode === "readonly" || leaseMode === "lost") && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium shrink-0">
              Read-only
            </span>
          )}
          {leaseMode === "handoff" && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium shrink-0">
              Handing over…
            </span>
          )}
          {statusText && (
            <span
              className={`text-xs px-2 py-0.5 rounded shrink-0 font-medium ${
                saving === "saving"
                  ? "bg-blue-100 text-blue-700"
                  : saving === "error"
                    ? "bg-red-100 text-red-700"
                    : "bg-green-100 text-green-700"
              }`}
            >
              {statusText}
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="p-1.5 text-gray-600 hover:bg-gray-100 rounded text-sm"
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>

          <a
            href={withAdminMode(`/api/documents/${docId}/export`)}
            download
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium flex items-center gap-1"
          >
            Export
          </a>

          <button
            onClick={() => setShowVersions(true)}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium flex items-center gap-1"
          >
            History ({versions.length})
          </button>

          {(currentPermission === "OWNER" || user.role === "ADMIN") && (
            <button
              onClick={() => {
                setShowShare(true);
                setShareError(null);
                setShareSuccess(null);
              }}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium"
            >
              Share
            </button>
          )}

          {canEditCanvas && (
            <button
              onClick={manualSave}
              disabled={saving === "saving"}
              title="Save to server (Ctrl+S / ⌘S)"
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded font-medium"
            >
              {saving === "saving" ? "Saving..." : "Save"}
            </button>
          )}

          {(currentPermission === "OWNER" || user.role === "ADMIN") && !isDeleted && (
            <button
              onClick={deleteDoc}
              className="p-1.5 text-gray-400 hover:text-red-600 rounded text-sm"
              title="Move to trash"
            >
              🗑️
            </button>
          )}
        </div>
      </header>

      {isReadOnlyBanner && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between text-sm">
          <div className="flex flex-col">
            <span className="text-amber-800">
              {leaseMode === "lost" ? "Editing was taken over. You are now viewing read-only." : "You are viewing read-only."}
            </span>
            {leaseError && <span role="alert" className="text-xs text-red-700 mt-1">{leaseError}</span>}
          </div>
          <button
            onClick={handleTakeover}
            disabled={leaseBusy}
            className="px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:bg-amber-300 text-xs font-medium"
          >
            {leaseBusy ? "Requesting..." : "Take over editing"}
          </button>
        </div>
      )}

      {/* Main Excalidraw Canvas */}
      <main className="flex-1 relative min-h-0">
        {leaseMode === "acquiring" && (
          <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">
            Acquiring edit lease…
          </div>
        )}
        {showLeaseConflict && leaseHolder && (
          <EditLeaseConflictModal
            holder={leaseHolder}
            busy={leaseBusy}
            error={leaseError}
            onReadOnly={handleOpenReadOnly}
            onTakeover={handleTakeover}
          />
        )}
        {showCanvas ? (
          <ExcalidrawCanvas
            key={`canvas-${docId}-${canvasKey}`}
            docId={docId}
            initialScene={initialCanvasScene}
            readOnly={!canEditCanvas}
            onSceneChange={handleChange}
            theme={theme}
          />
        ) : leaseMode === "blocked" ? null : (
          <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">
            Checking for unsaved changes…
          </div>
        )}
      </main>
      {draftConflict && (
        <RecoveryConflictModal
          client={summarizeRecoveryScene(draftConflict.draft.scene, draftConflict.draft.updatedAt)}
          server={summarizeRecoveryScene(draftConflict.serverScene, draftConflict.serverUpdatedAt)}
          preserveDiscarded={preserveDiscarded}
          busy={recoveryBusy}
          error={recoveryError}
          onPreserveChange={setPreserveDiscarded}
          onChoose={(choice) => void resolveDraftChoice(choice)}
        />
      )}

      {/* Version History Modal / Drawer */}
      {showVersions && (
        <div className="fixed inset-0 z-50 bg-black/40 flex justify-end">
          <div className="bg-white w-full max-w-md h-full shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="font-semibold text-lg">Version History</h2>
              <button
                onClick={() => setShowVersions(false)}
                className="text-gray-400 hover:text-gray-600 text-lg p-1"
              >
                ✕
              </button>
            </div>

            <div className="p-3 text-xs text-gray-500 bg-gray-50 border-b">
              Up to 20 snapshots are preserved. Restoring saves a snapshot of the current state before applying the selected version.
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {versions.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">No version snapshots yet.</p>
              ) : (
                versions.map((v) => (
                  <div
                    key={v.id}
                    className="border rounded-lg p-3 hover:border-blue-300 transition bg-white flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-gray-900 flex items-center gap-2">
                        Version {v.version_number}
                        <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded border font-normal">
                          {originBadgeLabel(v.origin)}
                        </span>
                      </span>
                      <span className="text-xs text-gray-500">
                        {new Date(v.created_at).toLocaleString()}
                      </span>
                    </div>

                    <div className="text-xs text-gray-600 flex items-center justify-between">
                      <span>By: {v.created_by_username || "User"}</span>
                      {canEditCanvas && (
                        <button
                          onClick={() => restoreVersion(v.id)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline"
                        >
                          Restore this version
                        </button>
                      )}
                    </div>

                    {v.thumbnail_path && (
                      <div className="w-full aspect-video bg-gray-100 rounded overflow-hidden mt-1 border">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/thumbnails/${v.thumbnail_path.replace(/^thumbnails[\\/]/, "").replace(/\\/g, "/")}`}
                          alt={`Version ${v.version_number}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Share & Permissions Modal */}
      {showShare && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="font-semibold text-lg">Document Sharing</h2>
              <button
                onClick={() => setShowShare(false)}
                className="text-gray-400 hover:text-gray-600 text-lg p-1"
              >
                ✕
              </button>
            </div>

            {/* Sub-tabs */}
            <div className="flex border-b text-sm">
              <button
                onClick={() => {
                  setShareTab("members");
                  setShareError(null);
                  setShareSuccess(null);
                }}
                className={`flex-1 py-2.5 font-medium border-b-2 ${
                  shareTab === "members"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                User Access
              </button>
              <button
                onClick={() => {
                  setShareTab("link");
                  setShareError(null);
                  setShareSuccess(null);
                }}
                className={`flex-1 py-2.5 font-medium border-b-2 ${
                  shareTab === "link"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Public Link
              </button>
              <button
                onClick={() => {
                  setShareTab("transfer");
                  setShareError(null);
                  setShareSuccess(null);
                }}
                className={`flex-1 py-2.5 font-medium border-b-2 ${
                  shareTab === "transfer"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Transfer Ownership
              </button>
            </div>

            {shareError && (
              <div className="mx-4 mt-3 rounded bg-red-50 text-red-700 px-3 py-2 text-xs">
                {shareError}
              </div>
            )}
            {shareSuccess && (
              <div className="mx-4 mt-3 rounded bg-green-50 text-green-700 px-3 py-2 text-xs">
                {shareSuccess}
              </div>
            )}

            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              {/* Tab 1: Member Sharing */}
              {shareTab === "members" && (
                <div className="space-y-4">
                  <form onSubmit={addMember} className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Username to share with..."
                      value={newMemberUsername}
                      onChange={(e) => setNewMemberUsername(e.target.value)}
                      className="flex-1 border rounded px-3 py-1.5 text-sm"
                      required
                    />
                    <button
                      type="submit"
                      className="bg-blue-600 text-white rounded px-4 py-1.5 text-sm hover:bg-blue-700 font-medium shrink-0"
                    >
                      Add Viewer
                    </button>
                  </form>

                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Shared Users ({members.length})
                    </h3>
                    {members.length === 0 ? (
                      <p className="text-sm text-gray-400 italic">
                        Not shared with any specific users yet.
                      </p>
                    ) : (
                      <ul className="divide-y border rounded">
                        {members.map((m) => (
                          <li
                            key={m.user_id}
                            className="flex items-center justify-between p-2.5 text-sm bg-white"
                          >
                            <span className="font-medium">{m.username}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                                {m.permission}
                              </span>
                              <button
                                onClick={() => removeMember(m.user_id)}
                                className="text-xs text-red-600 hover:underline"
                              >
                                Remove
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {/* Tab 2: Public Share Link */}
              {shareTab === "link" && (
                <div className="space-y-4 text-sm">
                  {shareLink && shareLink.is_active ? (
                    <div className="space-y-3 bg-gray-50 p-3 rounded border">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-green-700">Link is active</span>
                        <span className="text-xs text-gray-500">
                          {shareLink.expires_at
                            ? `Expires: ${new Date(shareLink.expires_at).toLocaleString()}`
                            : "No expiration"}
                        </span>
                      </div>

                      <div className="flex gap-2">
                        <input
                          readOnly
                          value={
                            typeof window !== "undefined"
                              ? `${window.location.origin}${shareLink.url}`
                              : shareLink.url
                          }
                          className="flex-1 border bg-white rounded px-2.5 py-1 text-xs text-gray-700 select-all"
                        />
                        <button
                          onClick={copyLinkUrl}
                          className="bg-blue-600 text-white text-xs px-3 py-1 rounded hover:bg-blue-700"
                        >
                          Copy
                        </button>
                      </div>

                      <div className="flex gap-2 justify-end pt-2">
                        <button
                          onClick={createOrUpdateLink}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          Regenerate Link
                        </button>
                        <button
                          onClick={deactivateLink}
                          className="text-xs text-red-600 hover:underline"
                        >
                          Deactivate Link
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-gray-600 text-xs">
                        Anyone with the public link can view this document without signing in.
                      </p>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">
                          Optional Expiration Date:
                        </label>
                        <input
                          type="datetime-local"
                          value={linkExpiresAt}
                          onChange={(e) => setLinkExpiresAt(e.target.value)}
                          className="border rounded px-2.5 py-1.5 text-xs w-full"
                        />
                      </div>
                      <button
                        onClick={createOrUpdateLink}
                        className="bg-blue-600 text-white rounded px-4 py-2 text-sm hover:bg-blue-700 w-full font-medium"
                      >
                        Create Read-only Share Link
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Ownership Transfer */}
              {shareTab === "transfer" && (
                <form onSubmit={transferDocOwnership} className="space-y-3">
                  <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
                    <strong>Warning:</strong> Transferring ownership is permanent unless the new
                    owner transfers it back. You will retain <em>EDITOR</em> access.
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      New Owner Username:
                    </label>
                    <input
                      type="text"
                      placeholder="Username of new owner"
                      value={transferUsername}
                      onChange={(e) => setTransferUsername(e.target.value)}
                      className="border rounded px-3 py-1.5 text-sm w-full"
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-red-600 text-white rounded px-4 py-2 text-sm hover:bg-red-700 font-medium w-full"
                  >
                    Transfer Ownership
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
