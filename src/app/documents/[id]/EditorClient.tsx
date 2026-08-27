"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ExcalidrawCanvas from "@/components/ExcalidrawCanvas";
import { api } from "@/lib/client";
import type { ExcalidrawScene, Permission } from "@/lib/types";

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
}: Props) {
  const router = useRouter();
  const [currentPermission, setCurrentPermission] = useState<Permission>(initialPermission);
  const [isDeleted, setIsDeleted] = useState(initialDeleted);

  const isOwner = currentPermission === "OWNER" || user.role === "ADMIN";
  const canEdit = currentPermission !== "VIEWER" && !isDeleted;

  const [title, setTitle] = useState(initialTitle);
  const [titleInput, setTitleInput] = useState(initialTitle);
  const [isEditingTitle, setIsEditingTitle] = useState(false);

  const [initialCanvasScene, setInitialCanvasScene] = useState<ExcalidrawScene>(initialScene);
  const [canvasKey, setCanvasKey] = useState(0);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [statusText, setStatusText] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [shareLink, setShareLink] = useState<ShareLinkInfo | null>(null);

  const [showVersions, setShowVersions] = useState(false);
  const [showShare, setShowShare] = useState(false);

  // Share modal state
  const [shareTab, setShareTab] = useState<"members" | "link" | "transfer">("members");
  const [newMemberUsername, setNewMemberUsername] = useState("");
  const [linkExpiresAt, setLinkExpiresAt] = useState("");
  const [transferUsername, setTransferUsername] = useState("");
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState<string | null>(null);

  const sceneRef = useRef(initialScene);
  const isDirtyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSnapshotRef = useRef<number>(Date.now());
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const data = await api<{ versions: VersionRow[] }>(`/api/documents/${docId}/versions`);
      setVersions(data.versions);
    } catch {
      // ignore
    }
  }, [docId]);

  const loadShare = useCallback(async () => {
    if (!isOwner) return;
    try {
      const [linkData, memberData] = await Promise.all([
        api<{ link: ShareLinkInfo | null }>(`/api/documents/${docId}/share/link`),
        api<{ members: MemberRow[] }>(`/api/documents/${docId}/share/members`),
      ]);
      setShareLink(linkData.link);
      setMembers(memberData.members);
    } catch {
      // ignore
    }
  }, [docId, isOwner]);

  useEffect(() => {
    loadVersions();
    if (isOwner) loadShare();
  }, [loadVersions, loadShare, isOwner]);

  // Load unsaved local draft only if strictly newer than cloud/server initialUpdatedAt
  useEffect(() => {
    try {
      const localDraft = localStorage.getItem(`excalidraw_draft_${docId}`);
      if (localDraft) {
        const parsed = JSON.parse(localDraft);
        const draftScene = parsed?.scene || parsed;
        const draftTimestamp = typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0;
        const serverTimestamp = initialUpdatedAt ? new Date(initialUpdatedAt).getTime() : 0;

        // If server is newer or equal, cloud wins and stale local draft is cleared
        if (serverTimestamp && draftTimestamp && serverTimestamp >= draftTimestamp) {
          localStorage.removeItem(`excalidraw_draft_${docId}`);
        } else if (draftScene && Array.isArray(draftScene.elements) && draftScene.elements.length > 0) {
          // If local draft is strictly newer than server timestamp (unsaved work from network drop/crash)
          if (!serverTimestamp || draftTimestamp > serverTimestamp) {
            sceneRef.current = draftScene;
            setInitialCanvasScene(draftScene);
            setCanvasKey((k) => k + 1);
            setStatus("Restored unsaved local draft", "saved");
          }
        }
      }
    } catch {
      // ignore
    }
  }, [docId, initialScene, initialUpdatedAt, setStatus]);

  // Flush unsaved changes on beforeunload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isDirtyRef.current && canEdit) {
        try {
          fetch(`/api/documents/${docId}/scene`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene: sceneRef.current, snapshot: false }),
            keepalive: true,
          });
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [canEdit, docId]);

  async function generateThumbnailBase64(currentScene: ExcalidrawScene): Promise<string | null> {
    if (!currentScene.elements || !Array.isArray(currentScene.elements) || currentScene.elements.length === 0) {
      return null;
    }
    try {
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements: currentScene.elements as any,
        appState: {
          exportBackground: true,
          viewBackgroundColor: (currentScene.appState as any)?.viewBackgroundColor || "#ffffff",
        },
        files: (currentScene.files as any) || {},
        mimeType: "image/png",
        maxWidthOrHeight: 400,
      });
      if (!blob) return null;
      return new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  const saveNow = useCallback(
    async (forceSnapshot: boolean) => {
      if (!canEdit) return;
      const current = sceneRef.current;
      setStatus("Saving...", "saving");
      try {
        const thumbnailBase64 = await generateThumbnailBase64(current);
        const res = await api<{ ok: boolean; snapshotCreated: boolean; updatedAt: string }>(
          `/api/documents/${docId}/scene`,
          {
            method: "PUT",
            body: JSON.stringify({
              scene: current,
              snapshot: forceSnapshot,
              thumbnailBase64,
            }),
          },
        );
        isDirtyRef.current = false;
        try {
          localStorage.removeItem(`excalidraw_draft_${docId}`);
        } catch {
          // ignore
        }
        if (res.snapshotCreated || forceSnapshot) {
          lastSnapshotRef.current = Date.now();
          await loadVersions();
        }
        setStatus(`Saved ${new Date().toLocaleTimeString()}`, "saved");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Save failed", "error");
      }
    },
    [canEdit, docId, loadVersions, setStatus],
  );

  const handleChange = useCallback(
    (s: ExcalidrawScene) => {
      if (!canEdit) return;
      sceneRef.current = s;
      isDirtyRef.current = true;

      // 1. Immediately cache in localStorage with timestamp
      try {
        localStorage.setItem(
          `excalidraw_draft_${docId}`,
          JSON.stringify({ scene: s, updatedAt: Date.now() }),
        );
      } catch {
        // ignore
      }

      // 2. Debounce auto-save to server
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const due = Date.now() - lastSnapshotRef.current >= SNAPSHOT_INTERVAL_MS;
        void saveNow(due);
      }, AUTO_SAVE_MS);
    },
    [canEdit, docId, saveNow],
  );

  const manualSave = useCallback(async () => {
    if (!canEdit) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setStatus("Saving snapshot...", "saving");
    try {
      const current = sceneRef.current;
      const thumbnailBase64 = await generateThumbnailBase64(current);
      const res = await api<{ versions: VersionRow[] }>(`/api/documents/${docId}/save`, {
        method: "POST",
        body: JSON.stringify({ scene: current, thumbnailBase64 }),
      });
      isDirtyRef.current = false;
      try {
        localStorage.removeItem(`excalidraw_draft_${docId}`);
      } catch {
        // ignore
      }
      lastSnapshotRef.current = Date.now();
      setVersions(res.versions);
      setStatus(`Saved ${new Date().toLocaleTimeString()}`, "saved");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed", "error");
    }
  }, [canEdit, docId, setStatus]);

  // Intercept Ctrl+S / Cmd+S globally to save immediately to server
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        if (canEdit) {
          void manualSave();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [canEdit, manualSave]);

  async function saveTitle() {
    setIsEditingTitle(false);
    const trimmed = titleInput.trim();
    if (!trimmed || trimmed === title || !canEdit) {
      setTitleInput(title);
      return;
    }
    try {
      const res = await api<{ document: { title: string } }>(`/api/documents/${docId}`, {
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
    if (!canEdit) return;
    if (!confirm("Restore this version? A new snapshot of the restored version will be created.")) {
      return;
    }
    try {
      setStatus("Restoring version...", "saving");
      await api(`/api/documents/${docId}/versions?action=restore&versionId=${versionId}`, {
        method: "POST",
      });
      const data = await api<{ document: { title: string }; scene: ExcalidrawScene; permission: Permission }>(
        `/api/documents/${docId}`,
      );
      sceneRef.current = data.scene;
      setInitialCanvasScene(data.scene);
      setCanvasKey((k) => k + 1);
      setTitle(data.document.title);
      setTitleInput(data.document.title);
      await loadVersions();
      setShowVersions(false);
      setStatus(`Restored version successfully`, "saved");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to restore version", "error");
    }
  }

  async function deleteDoc() {
    if (!confirm("Move this document to Trash?")) return;
    try {
      await api(`/api/documents/${docId}`, { method: "DELETE" });
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
      const res = await api<{ members: MemberRow[] }>(`/api/documents/${docId}/share/members`, {
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
      const res = await api<{ members: MemberRow[] }>(
        `/api/documents/${docId}/share/members?userId=${userId}`,
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
      const res = await api<{ link: ShareLinkInfo }>(`/api/documents/${docId}/share/link`, {
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
      await api(`/api/documents/${docId}/share/link`, { method: "DELETE" });
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
      await api(`/api/documents/${docId}/transfer`, {
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
          {canEdit ? (
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
          {!canEdit && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium shrink-0">
              {isDeleted ? "In Trash" : "Read-only"}
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
            href={`/api/documents/${docId}/export`}
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

          {isOwner && (
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

          {canEdit && (
            <button
              onClick={manualSave}
              disabled={saving === "saving"}
              title="Save to server (Ctrl+S / ⌘S)"
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded font-medium"
            >
              {saving === "saving" ? "Saving..." : "Save"}
            </button>
          )}

          {isOwner && !isDeleted && (
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

      {/* Main Excalidraw Canvas */}
      <main className="flex-1 relative min-h-0">
        <ExcalidrawCanvas
          key={`canvas-${docId}-${canvasKey}`}
          initialScene={initialCanvasScene}
          readOnly={!canEdit}
          onSceneChange={handleChange}
          theme={theme}
        />
      </main>

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
              Up to 20 recovery snapshots are preserved. Restoring a version creates a new current snapshot.
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
                      <span className="font-medium text-sm text-gray-900">
                        Version {v.version_number}
                      </span>
                      <span className="text-xs text-gray-500">
                        {new Date(v.created_at).toLocaleString()}
                      </span>
                    </div>

                    <div className="text-xs text-gray-600 flex items-center justify-between">
                      <span>By: {v.created_by_username || "User"}</span>
                      {canEdit && (
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