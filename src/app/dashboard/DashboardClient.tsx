"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, apiForm } from "@/lib/client";
import {
  canMoveFolderTo,
  DOC_DRAG_MIME,
  executeDocumentMoves,
  filterMovableDocumentIds,
  FOLDER_DRAG_MIME,
  getDisambiguatedChildFolders,
  getExcludedFolderIds,
  getFolderBreadcrumbsFromList,
  isOwnedDoc,
  reconcileSelectionAfterMove,
  resolveDragDocumentIds,
  shouldTriggerNavigationFeedback,
} from "@/lib/dashboard_document_move";
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
  const folderCreateVersion = useRef(0);
  const [breadcrumbs, setBreadcrumbs] = useState<FolderMeta[]>([]);
  const [shared, setShared] = useState<DocMeta[]>([]);
  const [trash, setTrash] = useState<DocMeta[]>([]);
  const [adminDocs, setAdminDocs] = useState<DocMeta[]>([]);
  const [users, setUsers] = useState<UserMeta[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isAdmin = initialUser.role === "ADMIN";

  const [folderModal, setFolderModal] = useState<{ mode: "rename"; folder: FolderMeta } | null>(null);
  const [folderNameInput, setFolderNameInput] = useState("");
  const [inlineDraft, setInlineDraft] = useState<{ parentId: string | null } | null>(null);
  const [inlineDraftName, setInlineDraftName] = useState("");
  const [inlineDraftError, setInlineDraftError] = useState<string | null>(null);
  const [inlineDraftSubmitting, setInlineDraftSubmitting] = useState(false);
  const inlineDraftInputRef = useRef<HTMLInputElement | null>(null);
  const inlineDraftSubmittingRef = useRef(false);
  const inlineDraftCancelledRef = useRef(false);
  const inlineDraftSuppressBlurRef = useRef(false);
  const inlineDraftComposingRef = useRef(false);
  const [moveModal, setMoveModal] = useState<
    | { type: "folder" | "deck"; id: string; title: string; currentFolderId: string | null }
    | { type: "document"; ids: string[]; title: string; currentFolderId: string | null }
    | null
  >(null);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [draggingDocIds, setDraggingDocIds] = useState<string[] | null>(null);
  const [draggingFolder, setDraggingFolder] = useState<{ id: string; name: string; parentId: string | null } | null>(
    null,
  );
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const draggingDocIdsRef = useRef<string[] | null>(null);
  const draggingFolderRef = useRef<{ id: string; name: string; parentId: string | null } | null>(null);
  const movingDocsRef = useRef(false);
  const [loadingData, setLoadingData] = useState(true);
  const loadRequestVersion = useRef(0);
  const [openingTarget, setOpeningTarget] = useState<{
    kind: "folder" | "document" | "deck";
    id: string | null;
    label: string;
  } | null>(null);
  const [moveStatus, setMoveStatus] = useState<{ label: string; source: "modal" | "drag" } | null>(null);
  const [moveTargetId, setMoveTargetId] = useState<string>("");
  const [moveFolderDraft, setMoveFolderDraft] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const folderDialogRef = useRef<HTMLDialogElement | null>(null);
  const moveDialogRef = useRef<HTMLDialogElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const moveBrowserFocusRef = useRef<HTMLButtonElement | null>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);

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
    (folderId: string | null, label?: string) => {
      if (folderId === currentFolderId) return;
      setOpeningTarget({ kind: "folder", id: folderId, label: label ?? "My Documents" });
      if (folderId) {
        router.push(`/dashboard?folder=${encodeURIComponent(folderId)}`);
      } else {
        router.push("/dashboard");
      }
    },
    [currentFolderId, router],
  );

  const load = useCallback(async () => {
    setError(null);
    const reqVersion = ++loadRequestVersion.current;
    const createVersion = folderCreateVersion.current;
    setLoadingData(true);
    try {
      const folderQuery = currentFolderId ? `&parentId=${encodeURIComponent(currentFolderId)}` : "";
      const [mineData, sharedData, trashData, deckData, folderData] = await Promise.all([
        api<{ documents: DocMeta[] }>("/api/documents"),
        api<{ documents: DocMeta[] }>("/api/documents/shared"),
        api<{ documents: DocMeta[] }>("/api/documents/trash"),
        api<{ decks: DeckWithPages[] }>("/api/decks"),
        api<{ folders: FolderMeta[]; breadcrumbs: FolderMeta[] }>(`/api/folders?all=1${folderQuery}`),
      ]);
      if (reqVersion !== loadRequestVersion.current) return;
      setMine(mineData.documents);
      setDecks(deckData.decks);
      setShared(sharedData.documents);
      setTrash(trashData.documents);
      if (createVersion === folderCreateVersion.current) setAllFolders(folderData.folders);
      setBreadcrumbs(folderData.breadcrumbs);
      if (currentFolderId && folderData.breadcrumbs.length === 0) {
        navigateToFolder(null, "My Documents");
        return;
      }
    } catch (err) {
      if (reqVersion !== loadRequestVersion.current) return;
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      if (reqVersion === loadRequestVersion.current) {
        setLoadingData(false);
        setOpeningTarget((prev) => (prev?.kind === "folder" && prev.id === currentFolderId ? null : prev));
      }
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

  const loadCurrentFolder = useRef(load);
  useEffect(() => {
    loadCurrentFolder.current = load;
    void load();
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

  const closeModals = useCallback(() => {
    folderDialogRef.current?.close();
    moveDialogRef.current?.close();
    setFolderModal(null);
    setMoveModal(null);
    setMoveFolderDraft(null);
    setModalError(null);
    const trigger = lastTriggerRef.current;
    lastTriggerRef.current = null;
    if (trigger && typeof trigger.focus === "function") {
      requestAnimationFrame(() => trigger.focus());
    }
  }, []);

  const openFolderModal = useCallback((modal: { mode: "rename"; folder: FolderMeta }) => {
    lastTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModalError(null);
    setFolderModal(modal);
  }, []);

  const startInlineDraft = useCallback(() => {
    if (inlineDraftSubmittingRef.current) return;
    if (query.trim().length > 0) {
      setQuery("");
    }
    if (inlineDraft) {
      inlineDraftSuppressBlurRef.current = false;
      inlineDraftInputRef.current?.focus();
      return;
    }
    inlineDraftCancelledRef.current = false;
    inlineDraftSubmittingRef.current = false;
    inlineDraftSuppressBlurRef.current = false;
    setInlineDraftName("");
    setInlineDraftError(null);
    setInlineDraft({ parentId: currentFolderId });
  }, [currentFolderId, inlineDraft, query]);

  const cancelInlineDraft = useCallback(() => {
    inlineDraftCancelledRef.current = true;
    setInlineDraft(null);
    setInlineDraftName("");
    setInlineDraftError(null);
  }, []);

  useEffect(() => {
    if (inlineDraft && inlineDraftInputRef.current) {
      inlineDraftInputRef.current.focus();
    }
  }, [inlineDraft]);

  useEffect(() => {
    if (inlineDraft && (inlineDraft.parentId !== currentFolderId || tab !== "mine")) {
      cancelInlineDraft();
    }
  }, [currentFolderId, tab, inlineDraft, cancelInlineDraft]);

  useEffect(() => {
    setSelectedDocIds([]);
    draggingDocIdsRef.current = null;
    draggingFolderRef.current = null;
    setDraggingDocIds(null);
    setDraggingFolder(null);
    setDragOverFolderId(null);
  }, [currentFolderId, tab]);

  useEffect(() => {
    setOpeningTarget(null);
  }, [tab]);

  useEffect(() => {
    function handlePageShow() {
      setOpeningTarget(null);
    }
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("popstate", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("popstate", handlePageShow);
    };
  }, []);

  const openMoveModal = useCallback(
    (
      modal:
        | { type: "folder" | "deck"; id: string; title: string; currentFolderId: string | null }
        | { type: "document"; ids: string[]; title: string; currentFolderId: string | null },
    ) => {
      lastTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setModalError(null);
      setMoveModal(modal);
    },
    [],
  );

  useEffect(() => {
    if (folderModal && folderDialogRef.current) {
      if (!folderDialogRef.current.open) {
        folderDialogRef.current.showModal();
      }
      folderInputRef.current?.focus();
    }
  }, [folderModal]);

  useEffect(() => {
    if (moveModal && moveDialogRef.current) {
      if (!moveDialogRef.current.open) {
        moveDialogRef.current.showModal();
      }
      moveBrowserFocusRef.current?.focus();
    }
  }, [moveModal, moveTargetId]);

  async function createFolderAt(name: string, parentId: string | null) {
    const { folder } = await api<{ folder: FolderMeta }>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name, parentId }),
    });
    folderCreateVersion.current += 1;
    setAllFolders((folders) => [...folders.filter((entry) => entry.id !== folder.id), folder].sort(
      (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) || a.created_at.localeCompare(b.created_at),
    ));
    return folder;
  }

  async function submitInlineDraft(source: "enter" | "blur") {
    if (source === "blur" && inlineDraftSuppressBlurRef.current) {
      inlineDraftSuppressBlurRef.current = false;
      return;
    }
    if (!inlineDraft || inlineDraftSubmittingRef.current || inlineDraftCancelledRef.current) return;
    const trimmed = inlineDraftName.trim();
    if (!trimmed) {
      if (source === "blur") {
        cancelInlineDraft();
      } else {
        setInlineDraftError("Folder name is required");
      }
      return;
    }
    if (trimmed.length > 100) {
      setInlineDraftError("Folder name must be 100 characters or less");
      return;
    }
    inlineDraftSubmittingRef.current = true;
    setInlineDraftSubmitting(true);
    setInlineDraftError(null);
    const targetParentId = inlineDraft.parentId;
    try {
      await createFolderAt(trimmed, targetParentId);
      inlineDraftCancelledRef.current = true;
      setInlineDraft(null);
      setInlineDraftName("");
    } catch (err) {
      setInlineDraftError(err instanceof Error ? err.message : "Failed to create folder");
      requestAnimationFrame(() => inlineDraftInputRef.current?.focus());
    } finally {
      inlineDraftSubmittingRef.current = false;
      setInlineDraftSubmitting(false);
    }
  }

  async function handleFolderSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!folderModal || modalSubmitting) return;
    setModalError(null);
    setModalSubmitting(true);
    try {
      await api(`/api/folders/${folderModal.folder.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: folderNameInput }),
      });
      setFolderNameInput("");
      closeModals();
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

  async function moveDocuments(
    docIds: readonly string[],
    targetFolderId: string | null,
    source: "modal" | "drag",
  ) {
    if (movingDocsRef.current) return;
    const movableIds = filterMovableDocumentIds(docIds, targetFolderId, docsInCurrent);
    if (movableIds.length === 0) {
      if (source === "modal") closeModals();
      return;
    }
    movingDocsRef.current = true;
    const moveLabel =
      movableIds.length === 1
        ? `Moving "${docsInCurrent.find((d) => d.id === movableIds[0])?.title ?? "document"}"...`
        : `Moving ${movableIds.length} documents...`;
    setMoveStatus({ label: moveLabel, source });
    if (source === "drag") setError(null);
    else setModalError(null);
    try {
      const result = await executeDocumentMoves(movableIds, targetFolderId, docsInCurrent, async (id, folderId) => {
        await api(`/api/documents/${id}/move`, {
          method: "PATCH",
          body: JSON.stringify({ folderId }),
        });
      });
      if (result.succeededIds.length > 0) {
        setSelectedDocIds((prev) => reconcileSelectionAfterMove(prev, result.succeededIds));
        await loadCurrentFolder.current();
      }
      if (result.errorMessage) {
        if (source === "modal") {
          setModalError(result.errorMessage);
          if (result.failed.length > 0) {
            const failedIds = result.failed.map((f) => f.id);
            setMoveModal((prev) =>
              prev && prev.type === "document"
                ? {
                    ...prev,
                    ids: failedIds,
                    title:
                      failedIds.length === 1
                        ? docsInCurrent.find((d) => d.id === failedIds[0])?.title ?? "1 document"
                        : `${failedIds.length} documents`,
                  }
                : prev,
            );
          }
        } else {
          setError(result.errorMessage);
        }
      } else if (source === "modal") {
        closeModals();
      }
    } finally {
      movingDocsRef.current = false;
      setMoveStatus(null);
    }
  }

  async function moveFolderTo(
    folderId: string,
    folderName: string,
    currentParentId: string | null,
    targetFolderId: string | null,
    source: "modal" | "drag",
  ) {
    if (movingDocsRef.current) return;
    if (!canMoveFolderTo(folderId, currentParentId, targetFolderId, allFolders)) {
      if (source === "modal" && targetFolderId === currentParentId) {
        closeModals();
      }
      return;
    }
    movingDocsRef.current = true;
    setMoveStatus({ label: `Moving "${folderName}"...`, source });
    if (source === "drag") setError(null);
    else setModalError(null);
    try {
      await api(`/api/folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ parentId: targetFolderId }),
      });
      await loadCurrentFolder.current();
      if (source === "modal") closeModals();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Move failed";
      if (source === "modal") setModalError(msg);
      else setError(msg);
    } finally {
      movingDocsRef.current = false;
      setMoveStatus(null);
    }
  }

  function hasInternalDocDrag(e: React.DragEvent): boolean {
    return (
      draggingDocIdsRef.current !== null &&
      Array.from(e.dataTransfer.types).includes(DOC_DRAG_MIME)
    );
  }

  function hasInternalFolderDrag(e: React.DragEvent): boolean {
    return (
      draggingFolderRef.current !== null &&
      Array.from(e.dataTransfer.types).includes(FOLDER_DRAG_MIME)
    );
  }

  function clearDragState() {
    draggingDocIdsRef.current = null;
    draggingFolderRef.current = null;
    setDraggingDocIds(null);
    setDraggingFolder(null);
    setDragOverFolderId(null);
  }

  function handleFolderDragOver(e: React.DragEvent, targetFolderId: string | null, dropKey: string) {
    if (hasInternalDocDrag(e)) {
      if (targetFolderId === currentFolderId) return;
    } else if (hasInternalFolderDrag(e)) {
      const folder = draggingFolderRef.current;
      if (!folder || !canMoveFolderTo(folder.id, folder.parentId, targetFolderId, allFolders)) return;
    } else {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverFolderId !== dropKey) {
      setDragOverFolderId(dropKey);
    }
  }

  function handleFolderDragLeave(e: React.DragEvent, dropKey: string) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (dragOverFolderId === dropKey) {
      setDragOverFolderId(null);
    }
  }

  function handleFolderDrop(e: React.DragEvent, targetFolderId: string | null) {
    if (hasInternalDocDrag(e)) {
      e.preventDefault();
      const ids = draggingDocIdsRef.current ?? [];
      clearDragState();
      if (ids.length === 0 || targetFolderId === currentFolderId) return;
      void moveDocuments(ids, targetFolderId, "drag");
      return;
    }
    if (hasInternalFolderDrag(e)) {
      e.preventDefault();
      const folder = draggingFolderRef.current;
      clearDragState();
      if (!folder || !canMoveFolderTo(folder.id, folder.parentId, targetFolderId, allFolders)) return;
      void moveFolderTo(folder.id, folder.name, folder.parentId, targetFolderId, "drag");
    }
  }

  async function handleMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!moveModal || modalSubmitting || movingDocsRef.current) return;
    setModalError(null);
    setModalSubmitting(true);
    const targetFolderId = moveTargetId === "" ? null : moveTargetId;
    try {
      if (moveFolderDraft !== null) {
        const name = moveFolderDraft.trim();
        if (!name) return;
        const folder = await createFolderAt(name, targetFolderId);
        setMoveFolderDraft(null);
        setMoveTargetId(folder.id);
        return;
      }
      if (moveModal.type === "document") {
        await moveDocuments(moveModal.ids, targetFolderId, "modal");
        return;
      }
      if (moveModal.type === "folder") {
        await moveFolderTo(moveModal.id, moveModal.title, moveModal.currentFolderId, targetFolderId, "modal");
        return;
      }
      if (targetFolderId === moveModal.currentFolderId) {
        closeModals();
        return;
      }
      movingDocsRef.current = true;
      setMoveStatus({ label: `Moving "${moveModal.title}"...`, source: "modal" });
      await api(`/api/decks/${moveModal.id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ folderId: targetFolderId }),
      });
      await loadCurrentFolder.current();
      closeModals();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Move failed");
    } finally {
      movingDocsRef.current = false;
      setMoveStatus(null);
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
        <TabButton
          active={tab === "shared"}
          onMouseDown={() => {
            if (inlineDraft) cancelInlineDraft();
          }}
          onClick={() => setTab("shared")}
        >
          Shared With Me
        </TabButton>
        <TabButton
          active={tab === "trash"}
          onMouseDown={() => {
            if (inlineDraft) cancelInlineDraft();
          }}
          onClick={() => setTab("trash")}
        >
          Trash
        </TabButton>
        {isAdmin && (
          <TabButton
            active={tab === "admin"}
            onMouseDown={() => {
              if (inlineDraft) cancelInlineDraft();
            }}
            onClick={() => setTab("admin")}
          >
            Admin Mode
          </TabButton>
        )}
      </nav>

      {error && (
        <div role="alert" className="mb-4 rounded bg-red-50 text-red-700 px-4 py-2 text-sm">{error}</div>
      )}

      {(moveStatus?.source === "drag" || openingTarget) && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full border border-blue-200 bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow-lg"
        >
          <Spinner className="h-3.5 w-3.5 text-white" />
          <span>
            {moveStatus?.source === "drag"
              ? moveStatus.label
              : `Opening "${openingTarget?.label}"...`}
          </span>
        </div>
      )}

{tab === "mine" && (
        <section className={selectedDocIds.length > 0 ? "pb-28" : undefined}>
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
              onMouseDown={() => {
                if (inlineDraft) {
                  inlineDraftSuppressBlurRef.current = true;
                }
              }}
              onClick={startInlineDraft}
              className="px-3 py-1.5 border bg-white rounded text-sm hover:bg-gray-50"
            >
              + New Folder
            </button>
          </div>

          <nav aria-label="Folder breadcrumbs" className="flex items-center gap-1.5 text-sm text-gray-600 mb-4 flex-wrap">
            <button
              onMouseDown={() => {
                if (inlineDraft && currentFolderId !== null) cancelInlineDraft();
              }}
              onClick={() => navigateToFolder(null, "My Documents")}
              onDragOver={(e) => handleFolderDragOver(e, null, "__root__")}
              onDragLeave={(e) => handleFolderDragLeave(e, "__root__")}
              onDrop={(e) => handleFolderDrop(e, null)}
              data-drop-active={
                (draggingDocIds !== null || draggingFolder !== null) && dragOverFolderId === "__root__"
                  ? "true"
                  : undefined
              }
              aria-busy={openingTarget?.kind === "folder" && openingTarget.id === null ? "true" : undefined}
              className={`inline-flex items-center gap-1 hover:underline rounded px-1 py-0.5 transition ${
                currentFolderId === null ? "font-semibold text-gray-900" : ""
              } ${
                (draggingDocIds !== null || draggingFolder !== null) && dragOverFolderId === "__root__"
                  ? "ring-2 ring-blue-500 bg-blue-50 text-blue-700"
                  : ""
              }`}
            >
              <span>My Documents</span>
              {openingTarget?.kind === "folder" && openingTarget.id === null && (
                <Spinner className="h-3 w-3 text-blue-600" />
              )}
            </button>
            {breadcrumbs.map((crumb) => {
              const isOpeningCrumb = openingTarget?.kind === "folder" && openingTarget.id === crumb.id;
              const isCrumbDropTarget =
                (draggingDocIds !== null || draggingFolder !== null) && dragOverFolderId === `crumb:${crumb.id}`;
              return (
                <span key={crumb.id} className="flex items-center gap-1.5">
                  <span className="text-gray-400">/</span>
                  <button
                    onMouseDown={() => {
                      if (inlineDraft && crumb.id !== currentFolderId) cancelInlineDraft();
                    }}
                    onClick={() => navigateToFolder(crumb.id, crumb.name)}
                    onDragOver={(e) => handleFolderDragOver(e, crumb.id, `crumb:${crumb.id}`)}
                    onDragLeave={(e) => handleFolderDragLeave(e, `crumb:${crumb.id}`)}
                    onDrop={(e) => handleFolderDrop(e, crumb.id)}
                    data-drop-active={isCrumbDropTarget ? "true" : undefined}
                    aria-busy={isOpeningCrumb ? "true" : undefined}
                    className={`inline-flex items-center gap-1 hover:underline rounded px-1 py-0.5 transition ${
                      crumb.id === currentFolderId ? "font-semibold text-gray-900" : ""
                    } ${isCrumbDropTarget ? "ring-2 ring-blue-500 bg-blue-50 text-blue-700" : ""}`}
                  >
                    <span>{crumb.name}</span>
                    {isOpeningCrumb && <Spinner className="h-3 w-3 text-blue-600" />}
                  </button>
                </span>
              );
            })}
          </nav>

          {selectedDocIds.length > 0 && (
            <div
              role="region"
              aria-label="Selected documents actions"
              className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm shadow-lg"
            >
              <span aria-live="polite" className="font-medium text-blue-900">
                {selectedDocIds.length} selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={moveStatus !== null || modalSubmitting}
                  onClick={() => {
                    setMoveTargetId(currentFolderId ?? "");
                    openMoveModal({
                      type: "document",
                      ids: selectedDocIds,
                      title:
                        selectedDocIds.length === 1
                          ? docsInCurrent.find((d) => d.id === selectedDocIds[0])?.title ?? "1 document"
                          : `${selectedDocIds.length} documents`,
                      currentFolderId,
                    });
                  }}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Move to folder
                </button>
                <button
                  type="button"
                  disabled={moveStatus !== null || modalSubmitting}
                  onClick={() => setSelectedDocIds([])}
                  className="px-3 py-1.5 bg-white border border-blue-200 text-blue-800 rounded text-xs font-medium hover:bg-blue-100 disabled:opacity-50"
                >
                  Clear selection
                </button>
              </div>
            </div>
          )}

          {isCurrentFolderEmpty && !inlineDraft ? (
            loadingData || openingTarget?.kind === "folder" ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded border border-dashed p-10 text-center text-gray-500 flex items-center justify-center gap-2"
              >
                <Spinner className="h-4 w-4 text-blue-600" />
                <span>Loading...</span>
              </div>
            ) : (
              <EmptyState message={currentFolderId ? "This folder is empty." : "No documents yet."} />
            )
          ) : hasSearchNoMatches && !inlineDraft ? (
            <EmptyState message={`No matches for "${query.trim()}" in this folder.`} />
          ) : (
            <>
              {(filteredFolders.length > 0 || inlineDraft) && (
                <div className="mb-8">
                  <h2 className="text-sm font-semibold text-gray-700 mb-3">Folders</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {inlineDraft && (
                      <div className="bg-white border rounded p-4 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span aria-hidden="true">📁</span>
                          <input
                            ref={inlineDraftInputRef}
                            type="text"
                            aria-label="New folder name"
                            value={inlineDraftName}
                            onChange={(e) => {
                              setInlineDraftName(e.target.value);
                              if (inlineDraftError) setInlineDraftError(null);
                            }}
                            onCompositionStart={() => {
                              inlineDraftComposingRef.current = true;
                            }}
                            onCompositionEnd={() => {
                              inlineDraftComposingRef.current = false;
                            }}
                            onKeyDown={(e) => {
                              if (e.nativeEvent.isComposing || e.keyCode === 229 || inlineDraftComposingRef.current) {
                                return;
                              }
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void submitInlineDraft("enter");
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelInlineDraft();
                              }
                            }}
                            onBlur={() => {
                              void submitInlineDraft("blur");
                            }}
                            placeholder="Folder name"
                            maxLength={100}
                            disabled={inlineDraftSubmitting}
                            className="flex-1 px-2 py-1 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        {inlineDraftError && (
                          <div role="alert" className="text-xs text-red-600">
                            {inlineDraftError}
                          </div>
                        )}
                      </div>
                    )}
                    {filteredFolders.map((folder) => {
                      const isDropTarget =
                        (draggingDocIds !== null || draggingFolder !== null) && dragOverFolderId === folder.id;
                      const isOpening = openingTarget?.kind === "folder" && openingTarget.id === folder.id;
                      const isDraggingThis = draggingFolder?.id === folder.id;
                      const canDragFolder = !inlineDraft && moveStatus === null && !modalSubmitting;
                      return (
                        <div
                          key={folder.id}
                          draggable={canDragFolder}
                          onDragStart={(e) => {
                            if (!canDragFolder) {
                              e.preventDefault();
                              return;
                            }
                            const payload = { id: folder.id, name: folder.name, parentId: folder.parent_id ?? null };
                            draggingFolderRef.current = payload;
                            setDraggingFolder(payload);
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData(FOLDER_DRAG_MIME, folder.id);
                            e.dataTransfer.setData("text/plain", folder.id);
                          }}
                          onDragEnd={clearDragState}
                          onDragOver={(e) => handleFolderDragOver(e, folder.id, folder.id)}
                          onDragLeave={(e) => handleFolderDragLeave(e, folder.id)}
                          onDrop={(e) => handleFolderDrop(e, folder.id)}
                          data-drop-active={isDropTarget ? "true" : undefined}
                          aria-busy={isOpening ? "true" : undefined}
                          className={`border rounded p-4 hover:shadow transition flex flex-col justify-between gap-2 ${
                            isDropTarget
                              ? "bg-blue-50 border-blue-500 ring-2 ring-blue-500"
                              : isOpening
                                ? "bg-blue-50/60 border-blue-400"
                                : "bg-white"
                          } ${isDraggingThis ? "opacity-60" : ""} ${
                            canDragFolder ? "cursor-grab active:cursor-grabbing" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              onMouseDown={() => {
                                if (inlineDraft) cancelInlineDraft();
                              }}
                              onClick={() => navigateToFolder(folder.id, folder.name)}
                              className="min-w-0 flex-1 text-left font-medium truncate hover:text-blue-600"
                            >
                              📁 {folder.name}
                            </button>
                            {isOpening && (
                              <span className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-700 font-medium">
                                <Spinner className="h-3 w-3 text-blue-600" />
                                Opening...
                              </span>
                            )}
                          </div>
                          <div className="flex gap-3 text-xs text-gray-500">
                            <button
                              onClick={() => {
                                setFolderNameInput(folder.name);
                                openFolderModal({ mode: "rename", folder });
                              }}
                              className="hover:text-gray-800 hover:underline"
                            >
                              Rename
                            </button>
                            <button
                              disabled={moveStatus !== null || modalSubmitting}
                              onClick={() => {
                                setMoveTargetId(folder.parent_id ?? "");
                                openMoveModal({
                                  type: "folder",
                                  id: folder.id,
                                  title: folder.name,
                                  currentFolderId: folder.parent_id ?? null,
                                });
                              }}
                              className="hover:text-gray-800 hover:underline disabled:opacity-50"
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
                      );
                    })}
                  </div>
                </div>
              )}

              {filteredDecks.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-sm font-semibold text-gray-700 mb-3">Presentation Decks</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredDecks.map((deck) => {
                      const isOpening = openingTarget?.kind === "deck" && openingTarget.id === deck.id;
                      return (
                        <div
                          key={deck.id}
                          aria-busy={isOpening ? "true" : undefined}
                          className={`border rounded p-4 hover:shadow transition flex flex-col justify-between gap-2 ${
                            isOpening ? "bg-blue-50/60 border-blue-400" : "bg-white"
                          }`}
                        >
                          <Link
                            href={`/decks/${deck.id}`}
                            onClick={(e) => {
                              if (shouldTriggerNavigationFeedback(e)) {
                                setOpeningTarget({ kind: "deck", id: deck.id, label: deck.title });
                              }
                            }}
                            className="block"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium truncate">{deck.title}</div>
                              {isOpening && (
                                <span className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-700 font-medium">
                                  <Spinner className="h-3 w-3 text-blue-600" />
                                  Opening...
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {deck.aspectRatio} / {deck.pages.length} page{deck.pages.length === 1 ? "" : "s"}
                            </div>
                          </Link>
                          <div className="flex gap-3 text-xs text-gray-500">
                            <button
                              disabled={moveStatus !== null || modalSubmitting}
                              onClick={() => {
                                setMoveTargetId(deck.folderId ?? "");
                                openMoveModal({
                                  type: "deck",
                                  id: deck.id,
                                  title: deck.title,
                                  currentFolderId: deck.folderId ?? null,
                                });
                              }}
                              className="hover:text-gray-800 hover:underline disabled:opacity-50"
                            >
                              Move
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {filteredMine.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-gray-700 mb-3">Documents</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredMine.map((d) => {
                      const owned = isOwnedDoc(d);
                      const isSelected = selectedDocIds.includes(d.id);
                      return (
                        <DocCard
                          key={d.id}
                          doc={d}
                          opening={openingTarget?.kind === "document" && openingTarget.id === d.id}
                          onOpen={(e) => {
                            if (shouldTriggerNavigationFeedback(e)) {
                              setOpeningTarget({ kind: "document", id: d.id, label: d.title });
                            }
                          }}
                          moveDisabled={moveStatus !== null || modalSubmitting}
                          selectable={owned}
                          selected={isSelected}
                          onToggleSelect={
                            owned
                              ? () =>
                                  setSelectedDocIds((prev) =>
                                    prev.includes(d.id) ? prev.filter((id) => id !== d.id) : [...prev, d.id],
                                  )
                              : undefined
                          }
                          draggable={owned}
                          onDragStart={
                            owned
                              ? (e) => {
                                  const ids = resolveDragDocumentIds(d.id, selectedDocIds, docsInCurrent);
                                  if (ids.length === 0) {
                                    e.preventDefault();
                                    return;
                                  }
                                  draggingDocIdsRef.current = ids;
                                  setDraggingDocIds(ids);
                                  e.dataTransfer.effectAllowed = "move";
                                  e.dataTransfer.setData(DOC_DRAG_MIME, JSON.stringify(ids));
                                  e.dataTransfer.setData("text/plain", ids.join(","));
                                }
                              : undefined
                          }
                          onDragEnd={owned ? clearDragState : undefined}
                          onMove={
                            owned
                              ? () => {
                                  setMoveTargetId(d.folder_id ?? "");
                                  openMoveModal({
                                    type: "document",
                                    ids: [d.id],
                                    title: d.title,
                                    currentFolderId: d.folder_id ?? null,
                                  });
                                }
                              : undefined
                          }
                        />
                      );
                    })}
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
                <DocCard
                  key={d.id}
                  doc={d}
                  opening={openingTarget?.kind === "document" && openingTarget.id === d.id}
                  onOpen={(e) => {
                    if (shouldTriggerNavigationFeedback(e)) {
                      setOpeningTarget({ kind: "document", id: d.id, label: d.title });
                    }
                  }}
                />
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
        <dialog
          ref={folderDialogRef}
          aria-labelledby="folder-modal-title"
          onCancel={(e) => {
            e.preventDefault();
            if (!modalSubmitting) closeModals();
          }}
          className="rounded-lg shadow-lg max-w-sm w-full p-5 backdrop:bg-black/40 m-auto"
        >
          <h3 id="folder-modal-title" className="text-base font-semibold mb-3">
            Rename Folder
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
                ref={folderInputRef}
                id="folder-name-input"
                type="text"
                value={folderNameInput}
                onChange={(e) => setFolderNameInput(e.target.value)}
                placeholder="Folder name"
                maxLength={100}
                required
                disabled={modalSubmitting}
                className="w-full px-3 py-2 border rounded text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={modalSubmitting}
                onClick={closeModals}
                className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={modalSubmitting}
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {modalSubmitting ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </dialog>
      )}

      {moveModal && (() => {
        const browsedFolderId = moveTargetId === "" ? null : moveTargetId;
        const excluded =
          moveModal.type === "folder" ? getExcludedFolderIds(moveModal.id, allFolders) : undefined;
        const pickerCrumbs = getFolderBreadcrumbsFromList(browsedFolderId, allFolders);
        const childFolders = getDisambiguatedChildFolders(browsedFolderId, allFolders, excluded);
        const isUnchanged = browsedFolderId === moveModal.currentFolderId;
        const isInvalidFolderTarget =
          moveModal.type === "folder" &&
          !canMoveFolderTo(moveModal.id, moveModal.currentFolderId, browsedFolderId, allFolders);
        const canConfirmMove = !modalSubmitting && (moveFolderDraft !== null ? !!moveFolderDraft.trim() : !isUnchanged && !isInvalidFolderTarget);

        return (
          <dialog
            ref={moveDialogRef}
            aria-labelledby="move-modal-title"
            aria-describedby="move-modal-hint"
            onClick={(e) => {
              if (modalSubmitting || e.target !== e.currentTarget) return;
              const { left, right, top, bottom } = e.currentTarget.getBoundingClientRect();
              if (e.clientX < left || e.clientX > right || e.clientY < top || e.clientY > bottom) closeModals();
            }}
            onCancel={(e) => {
              e.preventDefault();
              if (!modalSubmitting) closeModals();
            }}
            className="rounded-lg shadow-lg max-w-md w-full p-5 backdrop:bg-black/40 m-auto"
          >
            <h3 id="move-modal-title" className="mb-1 text-base font-semibold">
              Move &ldquo;{moveModal.title}&rdquo;
            </h3>
            <p id="move-modal-hint" className="mb-4 text-sm text-gray-500">Choose a destination folder.</p>
            {modalSubmitting && (
              <div
                role="status"
                aria-live="polite"
                className="mb-3 rounded bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800 flex items-center gap-2"
              >
                <Spinner className="h-3.5 w-3.5 text-blue-600" />
                <span>{moveFolderDraft !== null ? "Creating folder…" : moveStatus?.label ?? `Moving "${moveModal.title}"…`}</span>
              </div>
            )}
            {modalError && (
              <div role="alert" className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                {modalError}
              </div>
            )}
            <form onSubmit={handleMoveSubmit} className="space-y-4">
              <div className="space-y-2">
                <nav
                  aria-label="Destination folder breadcrumbs"
                  className="flex items-center gap-1 text-xs text-gray-600 flex-wrap bg-gray-50 border rounded px-2.5 py-2"
                >
                  <button
                    ref={browsedFolderId === null ? moveBrowserFocusRef : undefined}
                    type="button"
                    disabled={modalSubmitting}
                    onClick={() => setMoveTargetId("")}
                    aria-current={browsedFolderId === null ? "location" : undefined}
                    className={`hover:underline rounded px-1 py-0.5 ${
                      browsedFolderId === null ? "font-semibold text-gray-900" : ""
                    }`}
                  >
                    My Documents
                  </button>
                  {pickerCrumbs.map((crumb) => (
                    <span key={crumb.id} className="flex items-center gap-1">
                      <span className="text-gray-400">/</span>
                      <button
                        ref={crumb.id === browsedFolderId ? moveBrowserFocusRef : undefined}
                        type="button"
                        disabled={modalSubmitting}
                        onClick={() => setMoveTargetId(crumb.id)}
                        aria-current={crumb.id === browsedFolderId ? "location" : undefined}
                        className={`hover:underline rounded px-1 py-0.5 ${
                          crumb.id === browsedFolderId ? "font-semibold text-gray-900" : ""
                        }`}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </nav>

                <div
                  role="region"
                  aria-label="Subfolders in selected destination"
                  className="max-h-56 overflow-y-auto border rounded divide-y bg-white"
                >
                  {childFolders.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-gray-500">
                      No subfolders here.
                    </div>
                  ) : (
                    <ul>
                      {childFolders.map((child) => (
                        <li key={child.id}>
                          <button
                            type="button"
                            disabled={modalSubmitting || child.disabled}
                            onClick={() => setMoveTargetId(child.id)}
                            className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2 transition ${
                              child.disabled
                                ? "text-gray-400 bg-gray-50 cursor-not-allowed"
                                : "hover:bg-blue-50 focus:bg-blue-50 text-gray-800"
                            }`}
                          >
                            <span className="truncate">📁 {child.displayName}</span>
                            <span className="shrink-0 text-xs text-gray-400">
                              {child.disabled ? "Unavailable" : "›"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {moveFolderDraft !== null && (
                  <input autoFocus aria-label="Folder name" placeholder="Folder name" maxLength={100} disabled={modalSubmitting}
                    value={moveFolderDraft} onChange={(e) => setMoveFolderDraft(e.target.value)} className="w-full rounded border px-3 py-2 text-sm" />
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" disabled={modalSubmitting} onClick={() => { setModalError(null); setMoveFolderDraft(moveFolderDraft === null ? "" : null); }}
                  className="mr-auto rounded px-2 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                  {moveFolderDraft === null ? "+ New folder" : "Discard"}
                </button>
                <button
                  type="button"
                  disabled={modalSubmitting}
                  onClick={closeModals}
                  className="px-3 py-1.5 border rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canConfirmMove}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {moveFolderDraft !== null ? "Create" : "Move here"}
                </button>
              </div>
            </form>
          </dialog>
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
  onMouseDown,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onMouseDown?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={onMouseDown}
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

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={`motion-safe:animate-spin ${className}`}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function DocCard({
  doc,
  onMove,
  moveDisabled = false,
  opening = false,
  onOpen,
  selectable = false,
  selected = false,
  onToggleSelect,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  doc: DocMeta;
  onMove?: () => void;
  moveDisabled?: boolean;
  opening?: boolean;
  onOpen?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}) {
  const cleanThumb = doc.thumbnail_path
    ? `/api/thumbnails/${doc.thumbnail_path.replace(/^thumbnails[\\/]/, "").replace(/\\/g, "/")}`
    : null;
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={opening ? "true" : undefined}
      className={`group relative border rounded overflow-hidden hover:shadow transition flex flex-col ${
        selected
          ? "border-blue-600 bg-blue-50 ring-[3px] ring-blue-600"
          : opening
            ? "border-blue-400 bg-blue-50/60"
            : "bg-white"
      } ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      {selectable && onToggleSelect && (
        <label
          className={`absolute top-2 left-2 z-10 flex items-center justify-center rounded border p-1.5 cursor-pointer transition-opacity ${
            selected
              ? "opacity-100 border-blue-600 bg-white shadow-md"
              : "border-gray-300 bg-white/90 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          }`}
        >
          <input
            type="checkbox"
            aria-label={`Select ${doc.title}`}
            checked={selected}
            onChange={onToggleSelect}
            className={`accent-blue-700 cursor-pointer ${selected ? "h-5 w-5" : "h-4 w-4"}`}
          />
        </label>
      )}
      {opening && (
        <span className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white shadow">
          <Spinner className="h-3 w-3 text-white" />
          Opening...
        </span>
      )}
      <Link href={`/documents/${doc.id}`} draggable={false} onClick={onOpen} className="block">
        <div className="aspect-video bg-gray-100 flex items-center justify-center">
          {cleanThumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cleanThumb} alt={doc.title} draggable={false} className="w-full h-full object-cover" />
          ) : (
            <span className="text-gray-400 text-sm">Preview</span>
          )}
        </div>
      </Link>
      <div className="p-3 flex items-center justify-between gap-2 flex-1">
        <Link href={`/documents/${doc.id}`} draggable={false} onClick={onOpen} className="min-w-0 flex-1 block">
          <div className="font-medium truncate">{doc.title}</div>
          <div className="text-xs text-gray-500 mt-1">
            Updated {new Date(doc.updated_at).toLocaleString()}
          </div>
        </Link>
        {onMove && (
          <button
            type="button"
            disabled={moveDisabled}
            onClick={onMove}
            aria-label={`Move ${doc.title}`}
            className="shrink-0 text-xs text-gray-500 hover:text-gray-800 hover:underline px-1.5 py-1 rounded disabled:opacity-50"
          >
            Move
          </button>
        )}
      </div>
    </div>
  );
}
