import crypto from "node:crypto";
import { getDb, transaction } from "./db";
import type { FolderMeta, FolderRow } from "./types";

export class FolderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "FolderError";
    this.status = status;
  }
}

export const MAX_FOLDER_NAME_LENGTH = 100;
export const MAX_BATCH_MOVE_DOCUMENTS = 100;

export function parseDestinationFolderId(
  value: unknown,
  { required }: { required: boolean }
): string | null {
  if (value === undefined) {
    if (required) {
      throw new FolderError("Destination folderId is required", 400);
    }
    return null;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new FolderError("Invalid folderId: must be a string or null", 400);
  }
  return value;
}

export function validateFolderName(rawName: unknown): string {
  if (typeof rawName !== "string") {
    throw new FolderError("Folder name is required", 400);
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new FolderError("Folder name is required", 400);
  }
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    throw new FolderError(`Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or less`, 400);
  }
  return trimmed;
}

/**
 * Validate that `folderId` (if non-null) exists, belongs to `ownerId`, and
 * does not create a cycle when moving `movingFolderId`.
 */
export function validateDestinationFolder(
  ownerId: string,
  folderId: string | null | undefined,
  movingFolderId?: string
): FolderRow | null {
  if (folderId === null || folderId === undefined || folderId === "") {
    return null;
  }
  if (typeof folderId !== "string") {
    throw new FolderError("Invalid folderId", 400);
  }
  if (movingFolderId && folderId === movingFolderId) {
    throw new FolderError("Cannot move a folder into itself", 400);
  }

  const db = getDb();
  const target = db
    .prepare("SELECT * FROM folders WHERE id = ?")
    .get(folderId) as FolderRow | undefined;

  if (!target) {
    throw new FolderError("Destination folder not found", 404);
  }
  if (target.owner_id !== ownerId) {
    throw new FolderError("Forbidden: destination folder belongs to another user", 403);
  }

  if (movingFolderId) {
    // Walk ancestors of target to ensure movingFolderId is not an ancestor.
    const visited = new Set<string>();
    let currentParentId: string | null = target.parent_id;
    while (currentParentId) {
      if (currentParentId === movingFolderId) {
        throw new FolderError("Cannot move a folder into its own descendant", 400);
      }
      if (visited.has(currentParentId)) {
        break;
      }
      visited.add(currentParentId);
      const parent = db
        .prepare("SELECT id, owner_id, parent_id FROM folders WHERE id = ?")
        .get(currentParentId) as { id: string; owner_id: string; parent_id: string | null } | undefined;
      if (!parent || parent.owner_id !== ownerId) {
        break;
      }
      currentParentId = parent.parent_id;
    }
  }

  return target;
}

export function listFolders(ownerId: string, parentId: string | null = null): FolderMeta[] {
  const db = getDb();
  if (parentId === null) {
    return db
      .prepare(
        "SELECT id, name, owner_id, parent_id, created_at, updated_at FROM folders WHERE owner_id = ? AND parent_id IS NULL ORDER BY name COLLATE NOCASE ASC, created_at ASC"
      )
      .all(ownerId) as unknown as FolderMeta[];
  }
  return db
    .prepare(
      "SELECT id, name, owner_id, parent_id, created_at, updated_at FROM folders WHERE owner_id = ? AND parent_id = ? ORDER BY name COLLATE NOCASE ASC, created_at ASC"
    )
    .all(ownerId, parentId) as unknown as FolderMeta[];
}

export function listAllUserFolders(ownerId: string): FolderMeta[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, name, owner_id, parent_id, created_at, updated_at FROM folders WHERE owner_id = ? ORDER BY name COLLATE NOCASE ASC, created_at ASC"
    )
    .all(ownerId) as unknown as FolderMeta[];
}

export function getFolderByIdForOwner(ownerId: string, folderId: string): FolderMeta | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, owner_id, parent_id, created_at, updated_at FROM folders WHERE id = ? AND owner_id = ?")
    .get(folderId, ownerId) as FolderMeta | undefined;
  return row ?? null;
}

export function getFolderBreadcrumbs(ownerId: string, folderId: string | null): FolderMeta[] {
  if (!folderId) return [];
  const db = getDb();
  const chain: FolderMeta[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const row = db
      .prepare("SELECT id, name, owner_id, parent_id, created_at, updated_at FROM folders WHERE id = ? AND owner_id = ?")
      .get(currentId, ownerId) as FolderMeta | undefined;
    if (!row) {
      return [];
    }
    chain.push(row);
    currentId = row.parent_id;
  }

  return chain.reverse();
}

export function createFolder(ownerId: string, rawName: unknown, parentId: string | null = null): FolderMeta {
  const name = validateFolderName(rawName);
  const parent = validateDestinationFolder(ownerId, parentId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const resolvedParentId = parent ? parent.id : null;

  const db = getDb();
  db.prepare(
    "INSERT INTO folders (id, name, owner_id, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, ownerId, resolvedParentId, now, now);

  return {
    id,
    name,
    owner_id: ownerId,
    parent_id: resolvedParentId,
    created_at: now,
    updated_at: now,
  };
}

export function renameFolder(ownerId: string, folderId: string, rawName: unknown): FolderMeta {
  const name = validateFolderName(rawName);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM folders WHERE id = ?").get(folderId) as FolderRow | undefined;
  if (!existing) {
    throw new FolderError("Folder not found", 404);
  }
  if (existing.owner_id !== ownerId) {
    throw new FolderError("Forbidden", 403);
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?").run(name, now, folderId);

  return {
    ...existing,
    name,
    updated_at: now,
  };
}

export function moveFolder(ownerId: string, folderId: string, targetParentId: string | null): FolderMeta {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM folders WHERE id = ?").get(folderId) as FolderRow | undefined;
  if (!existing) {
    throw new FolderError("Folder not found", 404);
  }
  if (existing.owner_id !== ownerId) {
    throw new FolderError("Forbidden", 403);
  }

  const target = validateDestinationFolder(ownerId, targetParentId, folderId);
  const resolvedParentId = target ? target.id : null;
  const now = new Date().toISOString();

  db.prepare("UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?").run(resolvedParentId, now, folderId);

  return {
    ...existing,
    parent_id: resolvedParentId,
    updated_at: now,
  };
}

export function updateFolder(
  ownerId: string,
  folderId: string,
  updates: { name?: unknown; parentId?: unknown }
): FolderMeta {
  return transaction(() => {
    let folder: FolderMeta | null = null;
    if (updates.name !== undefined) {
      folder = renameFolder(ownerId, folderId, updates.name);
    }
    if (updates.parentId !== undefined) {
      const targetParentId = parseDestinationFolderId(updates.parentId, { required: true });
      folder = moveFolder(ownerId, folderId, targetParentId);
    }
    if (!folder) {
      throw new FolderError("No valid update fields provided", 400);
    }
    return folder;
  });
}

export function deleteFolder(ownerId: string, folderId: string): { reparentedTo: string | null } {
  return transaction(() => {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM folders WHERE id = ?").get(folderId) as FolderRow | undefined;
    if (!existing) {
      throw new FolderError("Folder not found", 404);
    }
    if (existing.owner_id !== ownerId) {
      throw new FolderError("Forbidden", 403);
    }

    const reparentedTo = existing.parent_id;
    const now = new Date().toISOString();

    db.prepare("UPDATE folders SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND owner_id = ?").run(
      reparentedTo,
      now,
      folderId,
      ownerId
    );
    // Reparent all documents in this folder, including trashed documents.
    db.prepare("UPDATE documents SET folder_id = ? WHERE folder_id = ? AND owner_id = ?").run(
      reparentedTo,
      folderId,
      ownerId
    );
    db.prepare("UPDATE decks SET folder_id = ? WHERE folder_id = ? AND owner_id = ?").run(
      reparentedTo,
      folderId,
      ownerId
    );
    db.prepare("DELETE FROM folders WHERE id = ? AND owner_id = ?").run(folderId, ownerId);

    return { reparentedTo };
  });
}

export function moveDocumentToFolder(
  ownerId: string,
  documentId: string,
  targetFolderId: string | null
): void {
  const db = getDb();
  const doc = db
    .prepare("SELECT id, owner_id FROM documents WHERE id = ?")
    .get(documentId) as { id: string; owner_id: string } | undefined;

  if (!doc) {
    throw new FolderError("Document not found", 404);
  }
  if (doc.owner_id !== ownerId) {
    throw new FolderError("Forbidden: only the owner can move this document", 403);
  }

  const deckPage = db
    .prepare("SELECT id FROM deck_pages WHERE document_id = ?")
    .get(documentId) as { id: string } | undefined;
  if (deckPage) {
    throw new FolderError("Deck page backing documents cannot be moved independently", 400);
  }

  const target = validateDestinationFolder(ownerId, targetFolderId);
  const resolvedFolderId = target ? target.id : null;

  db.prepare("UPDATE documents SET folder_id = ? WHERE id = ?").run(resolvedFolderId, documentId);
}

export interface BatchMoveFailure {
  id: string;
  error: string;
  status: number;
}

export function moveDocumentsToFolder(
  ownerId: string,
  rawDocumentIds: unknown,
  targetFolderId: string | null
): { folderId: string | null; movedIds: string[]; failed: BatchMoveFailure[] } {
  if (!Array.isArray(rawDocumentIds) || rawDocumentIds.length === 0) {
    throw new FolderError("documentIds must be a non-empty array", 400);
  }
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const item of rawDocumentIds) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new FolderError("documentIds must contain non-empty strings", 400);
    }
    if (!seen.has(item)) {
      seen.add(item);
      uniqueIds.push(item);
    }
  }
  if (uniqueIds.length > MAX_BATCH_MOVE_DOCUMENTS) {
    throw new FolderError(`Cannot move more than ${MAX_BATCH_MOVE_DOCUMENTS} documents at once`, 400);
  }

  return transaction(() => {
    const folderId = validateDestinationFolder(ownerId, targetFolderId)?.id ?? null;
    const movedIds: string[] = [];
    const failed: BatchMoveFailure[] = [];

    for (const docId of uniqueIds) {
      try {
        moveDocumentToFolder(ownerId, docId, folderId);
        movedIds.push(docId);
      } catch (err) {
        if (!(err instanceof FolderError)) throw err;
        failed.push({ id: docId, error: err.message, status: err.status });
      }
    }

    return { folderId, movedIds, failed };
  });
}

export function moveDeckToFolder(
  ownerId: string,
  deckId: string,
  targetFolderId: string | null
): void {
  const db = getDb();
  const deck = db
    .prepare("SELECT id, owner_id FROM decks WHERE id = ?")
    .get(deckId) as { id: string; owner_id: string } | undefined;

  if (!deck) {
    throw new FolderError("Deck not found", 404);
  }
  if (deck.owner_id !== ownerId) {
    throw new FolderError("Forbidden: only the owner can move this deck", 403);
  }

  const target = validateDestinationFolder(ownerId, targetFolderId);
  const resolvedFolderId = target ? target.id : null;

  db.prepare("UPDATE decks SET folder_id = ? WHERE id = ?").run(resolvedFolderId, deckId);
}
