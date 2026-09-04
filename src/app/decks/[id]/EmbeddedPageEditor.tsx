"use client";

import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import EditorClient, { type EditorClientControl } from "@/app/documents/[id]/EditorClient";
import { api } from "@/lib/client";
import type { DeckAspectRatio, DocumentMeta, EditLeaseCredentials, ExcalidrawScene, Permission, PublicUser } from "@/lib/types";

interface Props {
  documentId: string;
  user: PublicUser;
  onSaved?: () => void;
  controlRef: MutableRefObject<EditorClientControl | null>;
  recordingFrameAspectRatio: DeckAspectRatio;
  externalDeckLease: { deckId: string; credentials: EditLeaseCredentials };
  toolbarOrientation?: "horizontal" | "vertical";
}

interface DocumentPayload {
  document: DocumentMeta;
  scene: ExcalidrawScene;
  permission: Permission;
}

export default function EmbeddedPageEditor({ documentId, user, onSaved, controlRef, recordingFrameAspectRatio, externalDeckLease, toolbarOrientation = "horizontal" }: Props) {
  const [data, setData] = useState<DocumentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    api<DocumentPayload>(`/api/documents/${documentId}`)
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load page editor");
      });
    return () => {
      active = false;
    };
  }, [documentId]);

  if (error) {
    return <div className="w-full h-full flex items-center justify-center text-sm text-red-700 bg-red-50">{error}</div>;
  }
  if (!data) {
    return <div className="w-full h-full flex items-center justify-center text-sm text-slate-500">Loading page editor...</div>;
  }

  return (
    <EditorClient
      key={documentId}
      user={user}
      docId={documentId}
      initialTitle={data.document.title}
      initialScene={data.scene}
      initialUpdatedAt={data.document.updated_at}
      permission={data.permission}
      deleted={!!data.document.deleted_at}
      embedded
      onDocumentSaved={onSaved}
      controlRef={controlRef}
      recordingFrameAspectRatio={recordingFrameAspectRatio}
      externalDeckLease={externalDeckLease}
      embeddedToolbarOrientation={toolbarOrientation}
    />
  );
}
