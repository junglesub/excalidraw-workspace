"use client";

import React from "react";
import type { LeaseHolderSummary } from "@/lib/types";

interface EditLeaseConflictModalProps {
  holder: LeaseHolderSummary;
  busy: boolean;
  error: string | null;
  onReadOnly(): void;
  onTakeover(): void;
}

export default function EditLeaseConflictModal(props: EditLeaseConflictModalProps) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-lease-conflict-title"
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl"
      >
        <h2 id="edit-lease-conflict-title" className="text-lg font-semibold">
          Document is already being edited
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          This document is already being edited by <span className="font-medium text-gray-900">{props.holder.username}</span>. You can open it read-only or take over editing.
        </p>
        {props.error && (
          <p role="alert" className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {props.error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={props.onReadOnly}
            disabled={props.busy}
            className="px-4 py-2 rounded font-medium bg-gray-100 text-gray-800 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            Open read-only
          </button>
          <button
            type="button"
            onClick={props.onTakeover}
            disabled={props.busy}
            className="px-4 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 disabled:bg-red-300 disabled:cursor-not-allowed"
          >
            {props.busy ? "Taking over..." : "Take over editing"}
          </button>
        </div>
      </section>
    </div>
  );
}
