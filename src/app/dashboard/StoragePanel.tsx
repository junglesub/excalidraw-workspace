"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/client";

interface SqliteMetrics {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  reclaimableBytes: number;
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
}

interface StorageItemMetrics {
  fileCount: number;
  byteSize: number;
}

interface OrphanFileItem {
  type: "attachment" | "thumbnail";
  relativePath: string;
  absolutePath: string;
  byteSize: number;
  modifiedAt: string;
}

interface MissingFileItem {
  type: "attachment" | "thumbnail";
  id?: string;
  documentId?: string;
  fileId?: string;
  versionNumber?: number;
  expectedRelativePath: string;
  byteSize?: number;
}

interface StorageScanReport {
  database: SqliteMetrics;
  attachments: StorageItemMetrics;
  thumbnails: StorageItemMetrics;
  totalStorageBytes: number;
  legacyScenes: {
    documentsCount: number;
    versionsCount: number;
    totalCount: number;
  };
  orphans: {
    items: OrphanFileItem[];
    totalCount: number;
    totalBytes: number;
  };
  missingFiles: {
    items: MissingFileItem[];
    totalCount: number;
  };
  scannedAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function StoragePanel() {
  const [report, setReport] = useState<StorageScanReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<StorageScanReport>("/api/admin/storage");
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load storage report");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScan();
  }, [fetchScan]);

  async function handleCleanOrphans() {
    if (!report || report.orphans.totalCount === 0) return;
    const msg = `Are you sure you want to permanently delete ${report.orphans.totalCount} orphan files (${formatBytes(report.orphans.totalBytes)}) from disk?\n\nThis will only delete regular unreferenced files in data/attachments and data/thumbnails. Database rows will never be modified.`;
    if (!window.confirm(msg)) return;

    setActionLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api<{ deletedFiles: string[]; reclaimedBytes: number }>("/api/admin/storage", {
        method: "POST",
        body: JSON.stringify({ action: "cleanup", confirm: true }),
      });
      setSuccessMessage(`Cleanup complete: deleted ${res.deletedFiles.length} files, reclaimed ${formatBytes(res.reclaimedBytes)}.`);
      await fetchScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleVacuum() {
    const warning = `WARNING: SQLite VACUUM is a blocking operation that temporarily locks the database and creates a temporary copy to rebuild and defragment free pages.\n\nFree space to reclaim: ${formatBytes(report?.database.reclaimableBytes || 0)} (${report?.database.freelistCount || 0} pages).\n\nDo you want to proceed with VACUUM now?`;
    if (!window.confirm(warning)) return;

    setActionLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api<{ before: SqliteMetrics; after: SqliteMetrics; reclaimedBytes: number }>("/api/admin/storage", {
        method: "POST",
        body: JSON.stringify({ action: "vacuum", confirm: true }),
      });
      setSuccessMessage(`VACUUM complete! Database compacted. Reclaimed: ${formatBytes(res.reclaimedBytes)}.`);
      await fetchScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "VACUUM failed");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Storage & Database Maintenance</h2>
          <p className="text-xs text-gray-500">
            Monitor disk storage, SQLite freelist, legacy inline scenes, orphan files, and missing file references.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchScan}
            disabled={loading || actionLoading}
            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {loading ? "Scanning..." : "Refresh Scan"}
          </button>
          <button
            onClick={handleCleanOrphans}
            disabled={loading || actionLoading || !report || report.orphans.totalCount === 0}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            Clean Up Orphans ({report?.orphans.totalCount || 0})
          </button>
          <button
            onClick={handleVacuum}
            disabled={loading || actionLoading || !report}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            Run SQLite VACUUM
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded">
          {successMessage}
        </div>
      )}

      {report && (
        <>
          {/* Storage Overview Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="bg-white border rounded p-3">
              <div className="text-xs font-medium text-gray-500 uppercase">Database File</div>
              <div className="text-base font-semibold mt-1">{formatBytes(report.database.dbBytes)}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {report.database.pageCount} pages ({formatBytes(report.database.pageSize)}/page)
              </div>
            </div>

            <div className="bg-white border rounded p-3">
              <div className="text-xs font-medium text-gray-500 uppercase">WAL / SHM</div>
              <div className="text-base font-semibold mt-1">
                {formatBytes(report.database.walBytes + report.database.shmBytes)}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                WAL: {formatBytes(report.database.walBytes)}
              </div>
            </div>

            <div className="bg-white border rounded p-3">
              <div className="text-xs font-medium text-gray-500 uppercase">Attachments</div>
              <div className="text-base font-semibold mt-1">{formatBytes(report.attachments.byteSize)}</div>
              <div className="text-xs text-gray-400 mt-0.5">{report.attachments.fileCount} files on disk</div>
            </div>

            <div className="bg-white border rounded p-3">
              <div className="text-xs font-medium text-gray-500 uppercase">Thumbnails</div>
              <div className="text-base font-semibold mt-1">{formatBytes(report.thumbnails.byteSize)}</div>
              <div className="text-xs text-gray-400 mt-0.5">{report.thumbnails.fileCount} preview images</div>
            </div>

            <div className="bg-white border rounded p-3">
              <div className="text-xs font-medium text-gray-500 uppercase">SQLite Freelist</div>
              <div className="text-base font-semibold mt-1">{formatBytes(report.database.reclaimableBytes)}</div>
              <div className="text-xs text-gray-400 mt-0.5">{report.database.freelistCount} reclaimable pages</div>
            </div>

            <div className="bg-white border rounded p-3">
              <div className="text-xs font-medium text-gray-500 uppercase">Legacy Inline Scenes</div>
              <div className="text-base font-semibold mt-1">{report.legacyScenes.totalCount}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {report.legacyScenes.documentsCount} docs, {report.legacyScenes.versionsCount} versions
              </div>
            </div>
          </div>

          {/* Missing DB Files Warning Banner */}
          {report.missingFiles.totalCount > 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded p-4 text-sm text-amber-900 space-y-2">
              <div className="font-semibold flex items-center gap-1.5">
                <span>Missing Referenced Files ({report.missingFiles.totalCount})</span>
              </div>
              <p className="text-xs text-amber-800">
                The database references the following files, but they are not present on the disk filesystem. DB rows are preserved for historical integrity.
              </p>
              <div className="max-h-40 overflow-y-auto bg-white border border-amber-200 rounded p-2 text-xs font-mono">
                {report.missingFiles.items.map((m, idx) => (
                  <div key={idx} className="py-0.5">
                    [{m.type.toUpperCase()}] {m.expectedRelativePath} (Doc ID: {m.documentId || "N/A"})
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Orphan Files Details */}
          <div className="bg-white border rounded p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Orphan File Candidates ({report.orphans.totalCount} files, {formatBytes(report.orphans.totalBytes)})
              </h3>
              <span className="text-xs text-gray-400">
                Scanned at: {new Date(report.scannedAt).toLocaleTimeString()}
              </span>
            </div>

            {report.orphans.totalCount === 0 ? (
              <p className="text-xs text-gray-500 py-2">No orphan files detected. Storage is clean.</p>
            ) : (
              <div className="max-h-60 overflow-y-auto border rounded text-xs">
                <table className="w-full text-left">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="p-2">Type</th>
                      <th className="p-2">Relative Path</th>
                      <th className="p-2">Size</th>
                      <th className="p-2">Modified</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {report.orphans.items.map((o, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="p-2 font-medium">{o.type}</td>
                        <td className="p-2 font-mono">{o.relativePath}</td>
                        <td className="p-2">{formatBytes(o.byteSize)}</td>
                        <td className="p-2 text-gray-500">{new Date(o.modifiedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
