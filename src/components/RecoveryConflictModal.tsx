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

export function canConfirmSelection(selected: "client" | "server" | null, busy: boolean): boolean {
  return !!selected && !busy;
}

export function confirmRecoveryChoice(
  selected: "client" | "server" | null,
  busy: boolean,
  onChoose: (choice: "client" | "server") => void,
): boolean {
  if (!selected || busy) return false;
  onChoose(selected);
  return true;
}

export default function RecoveryConflictModal(props: RecoveryConflictModalProps) {
  const [selected, setSelected] = React.useState<"client" | "server" | null>(null);

  const handleSelect = (choice: "client" | "server") => {
    if (props.busy) return;
    setSelected(choice);
  };

  const handleConfirm = () => {
    confirmRecoveryChoice(selected, props.busy, props.onChoose);
  };

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
            const isSelected = selected === kind;
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={isSelected}
                aria-label={kind === "client" ? "Client draft" : "Server version"}
                disabled={props.busy}
                onClick={() => handleSelect(kind)}
                className={`rounded border p-3 text-sm text-left w-full transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                  isSelected
                    ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                    : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
                } ${props.busy ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <h3 className="font-medium flex items-center justify-between">
                  <span>{kind === "client" ? "Client draft" : "Server version"}</span>
                  {isSelected && (
                    <span aria-hidden="true" className="text-blue-600">
                      ✓
                    </span>
                  )}
                </h3>
                <p>Updated: {formatTime(item.updatedAt)}</p>
                <p>Elements: {item.elementCount}</p>
                <p>Images: {item.imageCount}</p>
              </button>
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
        {props.error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {props.error}
          </p>
        )}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            disabled={!canConfirmSelection(selected, props.busy)}
            onClick={handleConfirm}
            aria-label="Confirm selection"
            className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
          >
            Confirm selection
          </button>
        </div>
      </section>
    </div>
  );
}
