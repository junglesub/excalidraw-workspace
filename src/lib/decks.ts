import { getDb, transaction } from "./db";
import { createDocument, getDocumentRaw, getDocumentWithScene } from "./documents";
import { permanentDelete } from "./trash";
import { emptyScene } from "./types";
import type { DeckAspectRatio, DeckPage, DeckPageRow, DeckRow, DeckWithPages } from "./types";
import { HttpError } from "./http";

function nowIso(): string {
  return new Date().toISOString();
}

function assertAspectRatio(aspectRatio: string): asserts aspectRatio is DeckAspectRatio {
  if (aspectRatio !== "16:9" && aspectRatio !== "9:16") {
    throw new HttpError(400, "Unsupported deck aspect ratio");
  }
}

function rawDeck(id: string): DeckRow | undefined {
  return getDb().prepare("SELECT * FROM decks WHERE id = ?").get(id) as DeckRow | undefined;
}

function requireDeck(deckId: string, userId: string, role: "USER" | "ADMIN"): DeckRow {
  const deck = rawDeck(deckId);
  if (!deck) throw new HttpError(404, "Deck not found");
  if (deck.owner_id !== userId && role !== "ADMIN") {
    throw new HttpError(403, "Access denied");
  }
  return deck;
}

function pageRows(deckId: string): DeckPageRow[] {
  return getDb()
    .prepare("SELECT * FROM deck_pages WHERE deck_id = ? ORDER BY page_order ASC")
    .all(deckId) as DeckPageRow[];
}

function toPage(row: DeckPageRow): DeckPage {
  return {
    id: row.id,
    deckId: row.deck_id,
    documentId: row.document_id,
    title: row.title,
    order: row.page_order,
    thumbnailPath: getDocumentRaw(row.document_id)?.thumbnail_path ?? null,
  };
}

function toDeck(row: DeckRow): DeckWithPages {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    aspectRatio: row.aspect_ratio,
    ...(row.active_recording_baseline_id
      ? { activeRecordingBaselineId: row.active_recording_baseline_id }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pages: pageRows(row.id).map(toPage),
  };
}

function insertPage(deckId: string, documentId: string, title: string, order: number): DeckPageRow {
  const id = crypto.randomUUID();
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO deck_pages (id, deck_id, document_id, title, page_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, deckId, documentId, title, order, now, now);
  getDb().prepare("UPDATE decks SET updated_at = ? WHERE id = ?").run(now, deckId);
  return getDb().prepare("SELECT * FROM deck_pages WHERE id = ?").get(id) as DeckPageRow;
}

export function createDeck(
  ownerId: string,
  title: string,
  aspectRatio: DeckAspectRatio = "16:9",
): DeckWithPages {
  assertAspectRatio(aspectRatio);
  return transaction(() => {
    const id = crypto.randomUUID();
    const now = nowIso();
    getDb()
      .prepare(
        `INSERT INTO decks (id, title, owner_id, aspect_ratio, active_recording_baseline_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, title.trim() || "Untitled Deck", ownerId, aspectRatio, now, now);
    const doc = createDocument(ownerId, emptyScene(), "Page 1");
    insertPage(id, doc.id, "Page 1", 0);
    return toDeck(rawDeck(id)!);
  });
}

export function listDecks(userId: string): DeckWithPages[] {
  const rows = getDb()
    .prepare("SELECT * FROM decks WHERE owner_id = ? ORDER BY updated_at DESC")
    .all(userId) as DeckRow[];
  return rows.map(toDeck);
}

export function getDeck(deckId: string, userId: string, role: "USER" | "ADMIN"): DeckWithPages {
  return toDeck(requireDeck(deckId, userId, role));
}

export function renameDeck(
  deckId: string,
  title: string,
  userId: string,
  role: "USER" | "ADMIN",
): DeckWithPages {
  requireDeck(deckId, userId, role);
  const clean = title.trim();
  if (!clean) throw new HttpError(400, "Deck title is required");
  getDb().prepare("UPDATE decks SET title = ?, updated_at = ? WHERE id = ?").run(clean, nowIso(), deckId);
  return toDeck(rawDeck(deckId)!);
}

export function setDeckAspectRatio(
  deckId: string,
  aspectRatio: DeckAspectRatio,
  userId: string,
  role: "USER" | "ADMIN",
): DeckWithPages {
  requireDeck(deckId, userId, role);
  assertAspectRatio(aspectRatio);
  getDb()
    .prepare("UPDATE decks SET aspect_ratio = ?, updated_at = ? WHERE id = ?")
    .run(aspectRatio, nowIso(), deckId);
  return toDeck(rawDeck(deckId)!);
}

export function createBlankPage(
  deckId: string,
  userId: string,
  role: "USER" | "ADMIN",
): DeckPage {
  const deck = requireDeck(deckId, userId, role);
  const order = pageRows(deckId).length;
  const title = `Page ${order + 1}`;
  const doc = createDocument(deck.owner_id, emptyScene(), title);
  return toPage(insertPage(deckId, doc.id, title, order));
}

function requirePage(deckId: string, pageId: string): DeckPageRow {
  const row = getDb()
    .prepare("SELECT * FROM deck_pages WHERE id = ? AND deck_id = ?")
    .get(pageId, deckId) as DeckPageRow | undefined;
  if (!row) throw new HttpError(404, "Page not found");
  return row;
}

export function duplicatePage(
  deckId: string,
  pageId: string,
  userId: string,
  role: "USER" | "ADMIN",
): DeckPage {
  const deck = requireDeck(deckId, userId, role);
  const source = requirePage(deckId, pageId);
  const hydrated = getDocumentWithScene(source.document_id, userId, role, false, { hydrate: true }).scene;
  return transaction(() => {
    const title = `${source.title} Copy`;
    const doc = createDocument(deck.owner_id, hydrated, title);
    const copy = insertPage(deckId, doc.id, title, pageRows(deckId).length);
    const ids = pageRows(deckId).map((page) => page.id).filter((id) => id !== copy.id);
    const sourceIndex = ids.indexOf(source.id);
    ids.splice(sourceIndex + 1, 0, copy.id);
    reorderPages(deckId, ids, userId, role);
    return toPage(requirePage(deckId, copy.id));
  });
}

export function renamePage(
  deckId: string,
  pageId: string,
  title: string,
  userId: string,
  role: "USER" | "ADMIN",
): DeckPage {
  requireDeck(deckId, userId, role);
  const page = requirePage(deckId, pageId);
  const clean = title.trim();
  if (!clean) throw new HttpError(400, "Page title is required");
  const now = nowIso();
  transaction(() => {
    getDb().prepare("UPDATE deck_pages SET title = ?, updated_at = ? WHERE id = ?").run(clean, now, pageId);
    getDb().prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?").run(clean, now, page.document_id);
    getDb().prepare("UPDATE decks SET updated_at = ? WHERE id = ?").run(now, deckId);
  });
  return toPage(requirePage(deckId, pageId));
}

function normalizeOrders(deckId: string): void {
  const rows = pageRows(deckId);
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].page_order !== i) {
      getDb().prepare("UPDATE deck_pages SET page_order = ? WHERE id = ?").run(i, rows[i].id);
    }
  }
}

export function deletePage(
  deckId: string,
  pageId: string,
  userId: string,
  role: "USER" | "ADMIN",
): DeckWithPages {
  requireDeck(deckId, userId, role);
  const page = requirePage(deckId, pageId);
  getDb().prepare("DELETE FROM deck_pages WHERE id = ?").run(pageId);
  normalizeOrders(deckId);
  permanentDelete(page.document_id, userId, role, role === "ADMIN");
  getDb().prepare("UPDATE decks SET updated_at = ? WHERE id = ?").run(nowIso(), deckId);
  return toDeck(rawDeck(deckId)!);
}

export function reorderPages(
  deckId: string,
  pageIds: string[],
  userId: string,
  role: "USER" | "ADMIN",
): DeckWithPages {
  requireDeck(deckId, userId, role);
  const current = pageRows(deckId);
  const currentIds = current.map((row) => row.id);
  if (
    pageIds.length !== currentIds.length ||
    new Set(pageIds).size !== pageIds.length ||
    pageIds.some((id) => !currentIds.includes(id))
  ) {
    throw new HttpError(400, "Reorder must contain every deck page exactly once");
  }
  transaction(() => {
    // Avoid UNIQUE(deck_id, page_order) collisions by moving all rows to a temporary range first.
    getDb().prepare("UPDATE deck_pages SET page_order = page_order + 1000000 WHERE deck_id = ?").run(deckId);
    pageIds.forEach((id, index) => {
      getDb().prepare("UPDATE deck_pages SET page_order = ?, updated_at = ? WHERE id = ?").run(index, nowIso(), id);
    });
    getDb().prepare("UPDATE decks SET updated_at = ? WHERE id = ?").run(nowIso(), deckId);
  });
  return toDeck(rawDeck(deckId)!);
}

export function deleteDeck(
  deckId: string,
  userId: string,
  role: "USER" | "ADMIN",
): void {
  requireDeck(deckId, userId, role);
  const documents = pageRows(deckId).map((page) => page.document_id);
  getDb().prepare("DELETE FROM decks WHERE id = ?").run(deckId);
  for (const documentId of documents) {
    if (getDocumentRaw(documentId)) permanentDelete(documentId, userId, role, role === "ADMIN");
  }
}
