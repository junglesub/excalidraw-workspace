export const DOC_DRAG_MIME = "application/x-excalidraw-doc-ids";
export const FOLDER_DRAG_MIME = "application/x-excalidraw-folder-id";

export interface FolderNode {
  id: string;
  name: string;
  parent_id: string | null;
}

export function getExcludedFolderIds(
  folderId: string,
  allFolders: readonly FolderNode[],
): Set<string> {
  const excluded = new Set<string>([folderId]);
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
  return excluded;
}

export function canMoveFolderTo(
  folderId: string,
  currentParentId: string | null,
  targetFolderId: string | null,
  allFolders: readonly FolderNode[],
): boolean {
  if (targetFolderId === currentParentId) return false;
  if (targetFolderId !== null) {
    if (!allFolders.some((f) => f.id === targetFolderId)) return false;
    const excluded = getExcludedFolderIds(folderId, allFolders);
    if (excluded.has(targetFolderId)) return false;
  }
  return true;
}

export function getFolderBreadcrumbsFromList(
  folderId: string | null,
  allFolders: readonly FolderNode[],
): FolderNode[] {
  if (!folderId) return [];
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  const chain: FolderNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

export function getDisambiguatedChildFolders(
  parentId: string | null,
  allFolders: readonly FolderNode[],
  excludedIds?: ReadonlySet<string>,
): Array<{ id: string; name: string; displayName: string; disabled: boolean }> {
  const children = allFolders.filter((f) => (f.parent_id ?? null) === parentId);
  const nameCounts = new Map<string, number>();
  for (const child of children) {
    nameCounts.set(child.name, (nameCounts.get(child.name) ?? 0) + 1);
  }
  const seenCounts = new Map<string, number>();
  return children.map((child) => {
    const total = nameCounts.get(child.name) ?? 1;
    let displayName = child.name;
    if (total > 1) {
      const idx = (seenCounts.get(child.name) ?? 0) + 1;
      seenCounts.set(child.name, idx);
      displayName = `${child.name} (${idx})`;
    }
    return {
      id: child.id,
      name: child.name,
      displayName,
      disabled: excludedIds ? excludedIds.has(child.id) : false,
    };
  });
}

export interface MovableDoc {
  id: string;
  folder_id?: string | null;
  permission: "OWNER" | "EDITOR" | "VIEWER";
}

export interface DocumentMoveFailure {
  id: string;
  message: string;
}

export interface DocumentMoveResult {
  attemptedIds: string[];
  succeededIds: string[];
  failed: DocumentMoveFailure[];
  errorMessage: string | null;
}

export function isOwnedDoc(doc: MovableDoc): boolean {
  return doc.permission === "OWNER";
}

export function resolveDragDocumentIds(
  draggedDocId: string,
  selectedDocIds: readonly string[],
  docsInCurrent: readonly MovableDoc[],
): string[] {
  const ownedIds = new Set(docsInCurrent.filter(isOwnedDoc).map((d) => d.id));
  if (!ownedIds.has(draggedDocId)) return [];
  if (selectedDocIds.includes(draggedDocId)) {
    const validSelected = Array.from(new Set(selectedDocIds.filter((id) => ownedIds.has(id))));
    return validSelected.length > 0 ? validSelected : [draggedDocId];
  }
  return [draggedDocId];
}

export function filterMovableDocumentIds(
  docIds: readonly string[],
  targetFolderId: string | null,
  docsInCurrent: readonly MovableDoc[],
): string[] {
  const byId = new Map(docsInCurrent.map((d) => [d.id, d]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of docIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const doc = byId.get(id);
    if (!doc || !isOwnedDoc(doc)) continue;
    if ((doc.folder_id ?? null) === targetFolderId) continue;
    result.push(id);
  }
  return result;
}

export function reconcileSelectionAfterMove(
  selectedDocIds: readonly string[],
  succeededIds: readonly string[],
): string[] {
  if (succeededIds.length === 0) return [...selectedDocIds];
  const movedSet = new Set(succeededIds);
  return selectedDocIds.filter((id) => !movedSet.has(id));
}

export async function executeDocumentMoves(
  docIds: readonly string[],
  targetFolderId: string | null,
  docsInCurrent: readonly MovableDoc[],
  moveOne: (docId: string, folderId: string | null) => Promise<void>,
): Promise<DocumentMoveResult> {
  const attemptedIds = filterMovableDocumentIds(docIds, targetFolderId, docsInCurrent);
  if (attemptedIds.length === 0) {
    return { attemptedIds: [], succeededIds: [], failed: [], errorMessage: null };
  }

  const succeededIds: string[] = [];
  const failed: DocumentMoveFailure[] = [];

  for (const id of attemptedIds) {
    try {
      await moveOne(id, targetFolderId);
      succeededIds.push(id);
    } catch (err) {
      failed.push({
        id,
        message: err instanceof Error ? err.message : "Move failed",
      });
    }
  }

  let errorMessage: string | null = null;
  if (failed.length > 0) {
    const firstReason = failed[0].message;
    if (attemptedIds.length === 1) {
      errorMessage = firstReason;
    } else if (succeededIds.length === 0) {
      errorMessage = `Failed to move ${failed.length} documents: ${firstReason}`;
    } else {
      errorMessage = `Moved ${succeededIds.length} of ${attemptedIds.length} documents. Failed to move ${failed.length}: ${firstReason}`;
    }
  }

  return { attemptedIds, succeededIds, failed, errorMessage };
}
