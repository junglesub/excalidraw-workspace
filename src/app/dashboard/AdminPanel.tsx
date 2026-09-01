"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { StoragePanel } from "./StoragePanel";
import type { DocMeta, UserMeta } from "./DashboardClient";

interface Props {
  users: UserMeta[];
  docs: DocMeta[];
  query: string;
  setQuery: (q: string) => void;
  setError: (e: string | null) => void;
  filteredDocs: DocMeta[];
  onChanged: () => void;
  purge: (id: string) => void;
}

export function AdminPanel({
  users,
  docs,
  query,
  setQuery,
  setError,
  filteredDocs,
  onChanged,
  purge,
}: Props) {
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "USER" as "USER" | "ADMIN" });

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify(newUser) });
      setNewUser({ username: "", password: "", role: "USER" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    }
  }

  async function toggleActive(id: string, active: boolean) {
    setError(null);
    try {
      await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ is_active: !active }) });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function resetPassword(id: string) {
    const pwd = prompt("Enter the new password for this user:");
    if (!pwd) return;
    setError(null);
    try {
      await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ password: pwd }) });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    }
  }

  async function deleteUser(id: string) {
    if (!confirm("Delete this user account permanently?")) return;
    setError(null);
    try {
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-10">
      {/* Storage & Database Maintenance Section */}
      <section className="bg-white border rounded-lg p-5">
        <StoragePanel />
      </section>

      {/* User Management Section */}
      <section>
        <h2 className="text-lg font-semibold mb-3">System Users</h2>
        <form
          onSubmit={createUser}
          className="flex flex-wrap items-end gap-2 mb-4 p-4 bg-white border rounded"
        >
          <div>
            <label className="block text-xs text-gray-500 mb-1">Username</label>
            <input
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
              className="border border-gray-300 rounded px-2 py-1"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Password</label>
            <input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              className="border border-gray-300 rounded px-2 py-1"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <select
              value={newUser.role}
              onChange={(e) => setNewUser({ ...newUser, role: e.target.value as "USER" | "ADMIN" })}
              className="border border-gray-300 rounded px-2 py-1"
            >
              <option value="USER">USER</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white rounded px-4 py-2 text-sm hover:bg-blue-700"
          >
            Create User
          </button>
        </form>
        <div className="bg-white border rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Username</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="px-3 py-2">{u.username}</td>
                  <td className="px-3 py-2">{u.role}</td>
                  <td className="px-3 py-2">{u.is_active ? "Active" : "Disabled"}</td>
                  <td className="px-3 py-2 space-x-2">
                    <button
                      onClick={() => toggleActive(u.id, u.is_active)}
                      className="text-blue-600 hover:underline"
                    >
                      {u.is_active ? "Disable" : "Enable"}
                    </button>
                    <button onClick={() => resetPassword(u.id)} className="text-amber-600 hover:underline">
                      Reset Password
                    </button>
                    <button onClick={() => deleteUser(u.id)} className="text-red-600 hover:underline">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Document Overview Section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">All Documents ({docs.length})</h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title..."
            className="border border-gray-300 rounded px-3 py-2 text-sm w-56"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredDocs.map((d) => (
            <div key={d.id} className="bg-white border rounded p-3 flex flex-col justify-between">
              <div>
                <div className="font-medium truncate">{d.title}</div>
                <div className="text-xs text-gray-500">Owner: {d.owner_username}</div>
                <div className="text-xs text-gray-500">{d.deleted_at ? "In trash" : "Active"}</div>
              </div>
              <div className="mt-3 flex gap-2 items-center">
                <Link href={`/documents/${d.id}?adminMode=1`} className="text-sm text-blue-600 hover:underline">
                  Open
                </Link>
                {!d.deleted_at && (
                  <button onClick={() => purge(d.id)} className="text-sm text-red-600 hover:underline">
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
          {docs.length === 0 && <p className="text-gray-500 text-sm">No documents.</p>}
        </div>
      </section>
    </div>
  );
}
