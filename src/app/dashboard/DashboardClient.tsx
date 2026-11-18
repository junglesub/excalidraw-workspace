"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, apiForm } from "@/lib/client";
import type { DeckWithPages, FolderMeta } from "@/lib/types";
import { AdminPanel } from "./AdminPanel";

export interface DocMeta {
  id: string;
  title: string;
  owner_id: string;
  owner_username: string;
  folder_id?: string | null;
  permission: "OWNER" | "EDITOR" | "VIEWER";
  thumbnail_path: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface UserMeta {
  id: string;
  username: string;
  role: "USER" | "ADMIN";
  is_active: boolean;
}

interface Props {
  initialUser: UserMeta;
}

type Tab = "mine" | "shared" | "trash" | "admin";

export default function DashBoardClient({ initialUser }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentFolderId = searchParams.get("folder") || null;
  const [tab, setTab] = useState<Tab>("mine");
  const [mine, setMine] = useState<DocMeta[]>([]);
  const [decks, setDecks] = useState<DeckWithPages[]>([]);
  const [allFolders, setAllFolders] = useState<FolderMeta[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<FolderMeta[]>([]);
  const [shared, setShared] = useState<DocMeta[]>([]);
  const [trash, setTrash] = useState<DocMeta[]>([]);
  const [adminDocs, setAdminDocs] = useState<DocMeta[]>([]);
  const [users, setUsers] = useState<UserMeta[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isAdmin = initialUser.role === "ADMIN";

  const [folderModal, setFolderModal] = useState<{ mode: "create" | "rename"; folder?: FolderMeta } | null>(null);
  const [folderNameInput, setFolderNameInput] = useState("");
  const [moveModal, setMoveModal] = useState<{
    type: "folder" | "document" | "deck";
    id: string;
    title: string;
    currentFolderId: string | null;
  } | null>(null);
  const [moveTargetId, setMoveTargetId] = useState<string>("");
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    if (newPassword.length < 4) {
      setPasswordError("New password must be at least 4 characters");
      return;
    }

    setPasswordLoading(true);
    try {
      await api("/api/auth/password", {
        method: "PATCH",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setPasswordSuccess("Password changed successfully!");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => {
        setShowPasswordModal(false);
        setPasswordSuccess(null);
      }, 1500);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPasswordLoading(false);
    }
  }

  const navigateToFolder = useCallback(
    (folderId: string | null) => {
      if (folderId) {
        router.push(`/dashboard?folder=${encodeURIComponent(folderId)}`);
      } else {
        router.push("/dashboard");
      }
    },
    [router],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const folderQuery = currentFolderId ? `&parentId=${encodeURIComponent(currentFolderId)}` : "";
      const [mineData, sharedData, trashData, deckData, folderData] = await Promise.all([
        api<{ documents: DocMeta[] }>("/api/documents"),
        api<{ documents: DocMeta[] }>("/api/documents/shared"),
        api<{ documents: DocMeta[] }>("/api/documents/trash"),
        api<{ decks: DeckWithPages[] }>("/api/decks"),
        api<{ folders: FolderMeta[]; breadcrumbs: FolderMeta[] }>(`/api/folders?all=1${folderQuery}`),
      ]);
      setMine(mineData.documents);
      setDecks(deckData.decks);
      setShared(sharedData.documents);
      setTrash(trashData.documents);
      setAllFolders(folderData.folders);
      setBreadcrumbs(folderData.breadcrumbs);
      if (currentFolderId && folderData.breadcrumbs.length === 0) {
        navigateToFolder(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [currentFolderId, navigateToFolder]);

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [docs, usr] = await Promise.all([
        api<{ documents: DocMeta[] }>("/api/admin/documents"),
        api<{ users: UserMeta[] }>("/api/admin/users"),
      ]);
      setAdminDocs(docs.documents);
      setUsers(usr.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data");
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "admin") loadAdmin();
  }, [tab, loadAdmin]);

  async function createDeck() {
    setError(null);
    try {
      const res = await api<{ deck: DeckWithPages }>("/api/decks", {
        method: "POST",
        body: JSON.stringify({ title: "Untitled Deck", aspectRatio: "16:9", folderId: currentFolderId }),
      });
      router.push(`/decks/${res.deck.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create deck");
    }
  }

  async function createDoc() {
    setError(null);
    try {
      const res = await api<{ document: DocMeta }>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Untitled", folderId: currentFolderId }),
      });
      router.push(`/documents/${res.document.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    }
  }

  async function importExcal(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (currentFolderId) {
        form.append("folderId", currentFolderId);
      }
      const res = await apiForm<{ document: DocMeta }>("/api/documents/import", form);
      router.push(`/documents/${res.document.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  }

  useEffect(() => {
    if (!folderModal && !moveModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalSubmitting) {
        setFolderModal(null);
        setMoveModal(null);
        setModalError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [folderModal, moveModal, modalSubmitting]);

  async function handleFolderSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!folderModal || modalSubmitting) return;
    setModalError(null);
    setModalSubmitting(true);
    try {
      if (folderModal.mode === "create") {
        await api("/api/folders", {
          method: "POST",
          body: JSON.stringify({ name: folderNameInput, parentId: currentFolderId }),
        });
      } else if (folderModal.folder) {
        await api(`/api/folders/${folderModal.folder.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: folderNameInput }),
        });
      }
      setFolderModal(null);
      setFolderNameInput("");
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Folder action failed");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function handleDeleteFolder(folder: FolderMeta) {
    if (!confirm(`Delete folder "${folder.name}"? Its contents will be moved to its parent folder.`)) return;
    setError(null);
    try {
      await api(`/api/folders/${folder.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete folder");
    }
  }

  async function handleMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!moveModal || modalSubmitting) return;
    setModalError(null);
    setModalSubmitting(true);
    const targetFolderId = moveTargetId === "" ? null : moveTargetId;
    try {
      if (moveModal.type === "folder") {
        await api(`/api/folders/${moveModal.id}`, {
          method: "PATCH",
          body: JSON.stringify({ parentId: targetFolderId }),
        });
      } else if (moveModal.type === "document") {
        await api(`/api/documents/${moveModal.id}/move`, {
          method: "PATCH",
          body: JSON.stringify({ folderId: targetFolderId }),
        });
      } else {
        await api(`/api/decks/${moveModal.id}/move`, {
          method: "PATCH",
          body: JSON.stringify({ folderId: targetFolderId }),
        });
      }
      setMoveModal(null);
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Move failed");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function restore(id: string) {
    try {
      await api(`/api/documents/${id}?action=restore`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    }
  }

  async function purge(id: string) {
    if (!confirm("Permanently delete this document? This cannot be undone.")) return;
    try {
      await api(`/api/documents/${id}?permanent=1`, { method: "DELETE" });
      await load();
      if (tab === "admin") await loadAdmin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const foldersInCurrent = allFolders.filter((f) => (f.parent_id ?? null) === currentFolderId);
  const decksInCurrent = decks.filter((d) => (d.folderId ?? null) === currentFolderId);
  const docsInCurrent = mine.filter((d) => (d.folder_id ?? null) === currentFolderId);

  const filteredFolders = foldersInCurrent.filter((f) => f.name.toLowerCase().includes(normalizedQuery));
  const filteredDecks = decksInCurrent.filter((d) => d.title.toLowerCase().includes(normalizedQuery));
  const filteredMine = docsInCurrent.filter((d) => d.title.toLowerCase().includes(normalizedQuery));
  const isCurrentFolderEmpty = foldersInCurrent.length === 0 && decksInCurrent.length === 0 && docsInCurrent.length === 0;
  const hasSearchNoMatches =
    normalizedQuery.length > 0 && filteredFolders.length === 0 && filteredDecks.length === 0 && filteredMine.length === 0;
  const filteredAdmin = adminDocs.filter((d) => d.title.toLowerCase().includes(normalizedQuery));

  function logout() {
    fetch("/api/auth/logout", { method: "POST", credentials: "include" }).then(() => {
      router.push("/login");
      router.refresh();
    });
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Private Excalidraw Workspace</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">
            {initialUser.username}
            {initialUser.role === "ADMIN" && (
              <span className="ml-1 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                admin
              </span>
            )}
          </span>
          <button
            onClick={() => {
              setShowPasswordModal(true);
              setPasswordError(null);
              setPasswordSuccess(null);
              setCurrentPassword("");
              setNewPassword("");
              setConfirmPassword("");
            }}
            className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 hover:border-gray-300 rounded px-2 py-1 transition-colors bg-white shadow-xs"
          >
            Change password
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={logout} className="text-sm text-red-600 hover:underline">
            Sign out
          </button>
        </div>
      </header>

      <nav className="flex gap-2 mb-6 flex-wrap">
        <TabButton active={tab === "mine"} onClick={() => setTab("mine")}>
          My Documents
        </TabButton>
        <TabButton active={tab === "shared"} onClick={() => setTab("shared")}>
          Shared With Me
        </TabButton>
        <TabButton active={tab === "trash"} onClick={() => setTab("trash")}>
          Trash
        </TabButton>
        {isAdmin && (
          <TabButton active={tab === "admin"} onClick={() => setTab("admin")}>
            Admin Mode
          </TabButton>
        )}
      </nav>

      {error && (
        <div className="mb-4 rounded bg-red-50 text-red-700 px-4 py-2 text-sm">{error}</div>
      )}

{tab === "mine" && (
        <section>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title..."
              className="border border-gray-300 rounded px-3 py-2 text-sm w-64"
            />
            <button
              onClick={createDeck}
              className="bg-indigo-600 text-white rounded px-4 py-2 text-sm hover:bg-indigo-700"
            >
              + New Deck
            </button>
            <button
              onClick={createDoc}
              className="bg-blue-600 text-white rounded px-4 py-2 text-sm hover:bg-blue-700"
            >
              + New Document
            </button>
            <label className="text-sm bg-gray-200 rounded px-4 py-2 cursor-pointer hover:bg-gray-300">
              Import .excalidraw
              <input
                type="file"
                accept=".excalidraw,application/json"
                className="hidden"
                onChange={importExcal}
              />
            </label>
            <button
              onClick={() => {
                setFolderNameInput("");
                setFolderModal({ mode: "create" });
              }}
              className="px-3 py-1.5 border bg-white rounded text-sm hover:bg-gray-50"
            >
              + New Folder
            </button>
          </div>

          <nav aria-label="Folder breadcrumbs" className="flex items-center gap-1.5 text-sm text-gray-600 mb-4 flex-wrap">
            <button
              onClick={() => navigateToFolder(null)}
              className={`hover:underline ${currentFolderId === null ? "font-semibold text-gray-900" : ""}`}
            >
              My Documents
            </button>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.id} className="flex items-center gap-1.5">
                <span className="text-gray-400">/</span>
                <button
                  onClick={() => navigateToFolder(crumb.id)}
                  className={`hover:underline ${crumb.id === currentFolderId ? "font-semibold text-gray-900" : ""}`}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          {isCurrentFolderEmpty ? (
            <EmptyState message={currentFolderId ? "This folder is empty." : "No documents yet."} />
          ) : hasSearchNoMatches ? (
            <EmptyState message={`No matches for "${query.trim()}" in this folder.`} />
          ) : (
            <>
              {filteredFolders.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-sm font-semibold text-gray-700 mb-3">Folders</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredFolders.map((folder) => (
                      <div key={folder.id} className="bg-white border rounded p-4 hover:shadow transition flex flex-col justify-between gap-2">
                        <button
                          onClick={() => navigateToFolder(folder.id)}
                          className="text-left font-medium truncate hover:text-blue-600"
                        >
                          📁 {folder.name}
                        </button>
                        <div className="flex gap-3 text-xs text-gray-500">
                          <button
                            onClick={() => {
                              setFolderNameInput(folder.name);
                              setFolderModal({ mode: "rename", folder });
                            }}
                            className="hover:text-gray-800 hover:underline"
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => {
                              setMoveTargetId(folder.parent_id ?? "");
                              setMoveModal({
                                type: "folder",
                                id: folder.id,
                                title: folder.name,
                                currentFolderId: folder.parent_id ?? null,
                              });
                            }}
                            className="hover:text-gray-800 hover:underline"
                          >
                            Move
                          </button>
                          <button
                            onClick={() => handleDeleteFolder(folder)}
                            className="text-red-600 hover:underline"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {filteredDecks.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-sm font-semibold text-gray-700 mb-3">Presentation Decks</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredDecks.map((deck) => (
                      <div key={deck.id} className="bg-white border rounded p-4 hover:shadow transition flex flex-col justify-between gap-2">
                        <Link href={`/decks/${deck.id}`} className="block">
                          <div className="font-medium truncate">{deck.title}</div>
                          <div className="text-xs text-gray-500 mt-1">
                            {deck.aspectRatio} / {deck.pages.length} page{deck.pages.length === 1 ? "" : "s"}
                          </div>
                        </Link>
                        <div className="flex gap-3 text-xs text-gray-500">
                          <button
                            onClick={() => {
                              setMoveTargetId(deck.folderId ?? "");
                              setMoveModal({
                                type: "deck",
                                id: deck.id,
                                title: deck.title,
                                currentFolderId: deck.folderId ?? null,
                              });
                            }}
                            className="hover:text-gray-800 hover:underline"
                          >
                            Move
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {filteredMine.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-gray-700 mb-3">Documents</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredMine.map((d) => (
                      <DocCard
                        key={d.id}
                        doc={d}
                        onMove={() => {
                          setMoveTargetId(d.folder_id ?? "");
                          setMoveModal({
                            type: "document",
                            id: d.id,
                            title: d.title,
                            currentFolderId: d.folder_id ?? null,
                          });
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {tab === "shared" && (
        <section>
          {shared.length === 0 ? (
            <EmptyState message="No documents shared with you." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {shared.map((d) => (
                <DocCard key={d.id} doc={d} />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "trash" && (
        <section>
          {trash.length === 0 ? (
            <EmptyState message="Trash is empty." />
          ) : (
            <ul className="space-y-2">
              {trash.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between bg-white border rounded p-3"
                >
                  <div>
                    <div className="font-medium">{d.title}</div>
                    <div className="text-xs text-gray-500">
                      Deleted {d.deleted_at ? new Date(d.deleted_at).toLocaleString() : ""}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => restore(d.id)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Restore
                    </button>
                    <button
                      onClick={() => purge(d.id)}
                      className="text-sm text-red-600 hover:underline"
                    >
                      Delete Forever
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "admin" && isAdmin && (
        <AdminPanel
          users={users}
          docs={adminDocs}
          query={query}
          setQuery={setQuery}
          setError={setError}
          filteredDocs={filteredAdmin}
          onChanged={() => {
            loadAdmin();
            load();
          }}
          purge={purge}
        />
      )}

      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-lg">
            <h2 className="text-lg font-bold mb-4">Change Password</h2>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full border rounded px-3 py-1.5 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full border rounded px-3 py-1.5 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full border rounded px-3 py-1.5 text-sm"
                  required
                />
              </div>

              {passwordError && <p className="text-xs text-red-600">{passwordError}</p>}
              {passwordSuccess && <p className="text-xs text-green-600">{passwordSuccess}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50 text-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50"
                >
                  {passwordLoading ? "Saving..." : "Change Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {folderModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-modal-title"
        >
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-5">
            <h3 id="folder-modal-title" className="text-base font-semibold mb-3">
              {folderModal.mode === "create" ? "New Folder" : "Rename Folder"}
            </h3>
            {modalError && (
              <div role="alert" className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                {modalError}
              </div>
            )}
            <form onSubmit={handleFolderSubmit} className="space-y-4">
              <div>
                <label htmlFor="folder-name-input" className="block text-xs font-medium text-gray-700 mb-1">
                  Folder name
                </label>
                <input
                  id="folder-name-input"
                  type="text"
                  value={folderNameInput}
                  onChange={(e) => setFolderNameInput(e.target.value)}
                  placeholder="Folder name"
                  maxLength={100}
                  autoFocus
                  required
                  disabled={modalSubmitting}
                  className="w-full px-3 py-2 border rounded text-sm"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={modalSubmitting}
                  onClick={() => {
                    setFolderModal(null);
                    setModalError(null);
                  }}
                  className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={modalSubmitting}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {modalSubmitting ? "Saving..." : folderModal.mode === "create" ? "Create" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {moveModal && (() => {
        const byId = new Map(allFolders.map((f) => [f.id, f]));
        const excluded = new Set<string>();
        if (moveModal.type === "folder") {
          excluded.add(moveModal.id);
          let added = true;
          while (added) {
            added = false;
            for (const f of allFolders) {
              if (!excluded.has(f.id) && f.parent_id && excluded.has(f.parent_id)) {
                excluded.add(f.id);
                added = true;
              }
            }
          }
        }
        const pathCounts = new Map<string, number>();
        const rawOptions = allFolders
          .filter((f) => !excluded.has(f.id))
          .map((f) => {
            const parts: string[] = [];
            let cur: FolderMeta | undefined = f;
            const seen = new Set<string>();
            while (cur && !seen.has(cur.id)) {
              seen.add(cur.id);
              parts.unshift(cur.name);
              cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
            }
            const basePath = parts.join(" / ");
            pathCounts.set(basePath, (pathCounts.get(basePath) ?? 0) + 1);
            return { id: f.id, basePath };
          });
        const seenCounts = new Map<string, number>();
        const moveOptions = rawOptions.map((opt) => {
          const total = pathCounts.get(opt.basePath) ?? 1;
          if (total <= 1) return { id: opt.id, label: opt.basePath };
          const idx = (seenCounts.get(opt.basePath) ?? 0) + 1;
          seenCounts.set(opt.basePath, idx);
          return { id: opt.id, label: `${opt.basePath} (${idx})` };
        });

        return (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-modal-title"
          >
            <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-5">
              <h3 id="move-modal-title" className="text-base font-semibold mb-1">
                Move &ldquo;{moveModal.title}&rdquo;
              </h3>
              <p className="text-xs text-gray-500 mb-3">Select destination folder</p>
              {modalError && (
                <div role="alert" className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                  {modalError}
                </div>
              )}
              <form onSubmit={handleMoveSubmit} className="space-y-4">
                <div>
                  <label htmlFor="move-destination-select" className="block text-xs font-medium text-gray-700 mb-1">
                    Destination folder
                  </label>
                  <select
                    id="move-destination-select"
                    value={moveTargetId}
                    onChange={(e) => setMoveTargetId(e.target.value)}
                    disabled={modalSubmitting}
                    className="w-full px-3 py-2 border rounded text-sm bg-white"
                  >
                    <option value="">My Documents (Root)</option>
                    {moveOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={modalSubmitting}
                    onClick={() => {
                      setMoveModal(null);
                      setModalError(null);
                    }}
                    className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={modalSubmitting}
                    className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {modalSubmitting ? "Moving..." : "Move"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      <footer className="mt-12 pt-6 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between text-xs text-gray-400 gap-2">
        <div className="flex items-center gap-2">
          <span>Private Excalidraw Workspace</span>
          <span className="font-mono text-[11px] bg-gray-100 px-1.5 py-0.5 rounded text-gray-500">
            Build: {process.env.NEXT_PUBLIC_BUILD_VERSION || "dev"}
          </span>
        </div>
        <div>
          <a
            href="https://github.com/junglesub/excalidraw-workspace"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-gray-600 transition-colors"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded text-sm font-medium ${
        active ? "bg-blue-600 text-white" : "bg-white text-gray-700 border hover:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded border border-dashed p-10 text-center text-gray-500">{message}</div>
  );
}

function DocCard({ doc, onMove }: { doc: DocMeta; onMove?: () => void }) {
  const cleanThumb = doc.thumbnail_path
    ? `/api/thumbnails/${doc.thumbnail_path.replace(/^thumbnails[\\/]/, "").replace(/\\/g, "/")}`
    : null;
  return (
    <div className="group bg-white border rounded overflow-hidden hover:shadow transition flex flex-col">
      <Link href={`/documents/${doc.id}`} className="block flex-1">
        <div className="aspect-video bg-gray-100 flex items-center justify-center">
          {cleanThumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cleanThumb} alt={doc.title} className="w-full h-full object-cover" />
          ) : (
            <span className="text-gray-400 text-sm">Preview</span>
          )}
        </div>
        <div className="p-3 pb-2">
          <div className="font-medium truncate">{doc.title}</div>
          <div className="text-xs text-gray-500 mt-1">
            Updated {new Date(doc.updated_at).toLocaleString()}
          </div>
        </div>
      </Link>
      {onMove && (
        <div className="px-3 pb-3 pt-1 flex gap-3 text-xs text-gray-500">
          <button
            type="button"
            onClick={onMove}
            className="hover:text-gray-800 hover:underline"
          >
            Move
          </button>
        </div>
      )}
    </div>
  );
}