"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, apiForm } from "@/lib/client";
import { AdminPanel } from "./AdminPanel";

export interface DocMeta {
  id: string;
  title: string;
  owner_id: string;
  owner_username: string;
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
  const [tab, setTab] = useState<Tab>("mine");
  const [mine, setMine] = useState<DocMeta[]>([]);
  const [shared, setShared] = useState<DocMeta[]>([]);
  const [trash, setTrash] = useState<DocMeta[]>([]);
  const [adminDocs, setAdminDocs] = useState<DocMeta[]>([]);
  const [users, setUsers] = useState<UserMeta[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isAdmin = initialUser.role === "ADMIN";

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

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mineData, sharedData, trashData] = await Promise.all([
        api<{ documents: DocMeta[] }>("/api/documents"),
        api<{ documents: DocMeta[] }>("/api/documents/shared"),
        api<{ documents: DocMeta[] }>("/api/documents/trash"),
      ]);
      setMine(mineData.documents);
      setShared(sharedData.documents);
      setTrash(trashData.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

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

  async function createDoc() {
    setError(null);
    try {
      const res = await api<{ document: DocMeta }>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Untitled" }),
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
      const res = await apiForm<{ document: DocMeta }>("/api/documents/import", form);
      router.push(`/documents/${res.document.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
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

  const filteredMine = mine.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()));
  const filteredAdmin = adminDocs.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()));

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
          </div>
          {filteredMine.length === 0 ? (
            <EmptyState message="No documents yet." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredMine.map((d) => (
                <DocCard key={d.id} doc={d} />
              ))}
            </div>
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

      <footer className="mt-12 pt-6 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between text-xs text-gray-400 gap-2">
        <div className="flex items-center gap-2">
          <span>Private Excalidraw Workspace</span>
          <span>·</span>
          <span>v1.0.0</span>
          <span>·</span>
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

function DocCard({ doc }: { doc: DocMeta }) {
  const cleanThumb = doc.thumbnail_path
    ? `/api/thumbnails/${doc.thumbnail_path.replace(/^thumbnails[\\/]/, "").replace(/\\/g, "/")}`
    : null;
  return (
    <Link
      href={`/documents/${doc.id}`}
      className="group bg-white border rounded overflow-hidden hover:shadow transition block"
    >
      <div className="aspect-video bg-gray-100 flex items-center justify-center">
        {cleanThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cleanThumb} alt={doc.title} className="w-full h-full object-cover" />
        ) : (
          <span className="text-gray-400 text-sm">Preview</span>
        )}
      </div>
      <div className="p-3">
        <div className="font-medium truncate">{doc.title}</div>
        <div className="text-xs text-gray-500 mt-1">
          Updated {new Date(doc.updated_at).toLocaleString()}
        </div>
      </div>
    </Link>
  );
}