"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ExcalidrawCanvas from "@/components/ExcalidrawCanvas";
import { api } from "@/lib/client";
import type { ExcalidrawScene } from "@/lib/types";
import { emptyScene } from "@/lib/types";

interface ShareData {
  document: { id: string; title: string; updated_at: string };
  scene: ExcalidrawScene;
}

export default function ShareViewer({ token }: { token: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<ShareData>(`/api/share/${token}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Invalid or expired link"))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">Loading...</div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <div className="text-2xl font-semibold text-red-600">Link unavailable</div>
        <p className="text-gray-600">{error || "This document could not be loaded."}</p>
        <p className="text-sm text-gray-500">
          The share link may be invalid, deactivated, or expired.
        </p>
        <Link href="/login" className="text-blue-600 hover:underline text-sm">
          Go to login
        </Link>
      </div>
    );
  }

  const handleSceneChange = () => {};

  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center gap-3 px-4 py-2 bg-white border-b">
        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
          Read-only shared view
        </span>
        <span className="flex-1 truncate font-medium text-sm">{data.document.title}</span>
        <span className="text-xs text-gray-500">
          Updated {new Date(data.document.updated_at).toLocaleString()}
        </span>
      </header>
      <main className="flex-1 min-h-0">
        <ExcalidrawCanvas
          docId={data.document.id}
          shareToken={token}
          initialScene={data.scene || emptyScene()}
          readOnly
          onSceneChange={handleSceneChange}
        />
      </main>
    </div>
  );
}