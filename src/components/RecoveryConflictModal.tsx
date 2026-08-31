"use client";

import React from "react";
import type { RecoverySceneSummary } from "@/lib/client_save";

interface RecoveryConflictModalProps {
  client: RecoverySceneSummary;
  server: RecoverySceneSummary;
  preserveDiscarded: boolean;
  busy: boolean;
  error: string | null;
  onPreserveChange(value: boolean): void;
  onChoose(choice: "client" | "server"): void;
}

function formatTime(value: number | string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export default function RecoveryConflictModal(props: RecoveryConflictModalProps) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-conflict-title"
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl"
      >
        <h2 id="recovery-conflict-title" className="text-lg font-semibold">
          Unsaved changes conflict
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Choose which version to use. Times are shown for context only.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(["client", "server"] as const).map((kind) => {
            const item = props[kind];
            return (
              <div key={kind} className="rounded border p-3 text-sm">
                <h3 className="font-medium">{kind === "client" ? "Client draft" : "Server version"}</h3>
                <p>Updated: {formatTime(item.updatedAt)}</p>
                <p>Elements: {item.elementCount}</p>
                <p>Images: {item.imageCount}</p>
              </div>
            );
          })}
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={props.preserveDiscarded}
            disabled={props.busy}
            onChange={(event) => props.onPreserveChange(event.target.checked)}
          />
          Preserve the version not selected as a recovery snapshot
        </label>
        {props.error && <p role="alert" className="mt-3 text-sm text-red-700">{props.error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={props.busy} onClick={() => props.onChoose("server")}>
            Use server version
          </button>
          <button type="button" disabled={props.busy} onClick={() => props.onChoose("client")}>
            Use client draft
          </button>
        </div>
      </section>
    </div>
  );
}
