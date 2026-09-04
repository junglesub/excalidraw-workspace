import { getDb, transaction } from "./db";
import { getDeck } from "./decks";
import { getDocumentRaw } from "./documents";
import { HttpError } from "./http";
import { hasActiveEditLease } from "./edit_lease";
import {
  createPinnedSnapshotFromDoc,
  getVersion,
  restoreVersionWithoutLease,
} from "./versions";

export interface NamedSnapshot {
  id: string;
  pageId: string;
  name: string;
  snapshotId: string;
  createdAt: string;
}

export interface RecordingBaselinePage {
  pageId: string;
  documentId: string;
  snapshotId: string;
}

export interface RecordingBaseline {
  id: string;
  deckId: string;
  createdBy: string;
  createdAt: string;
  pages: RecordingBaselinePage[];
}

type NamedSnapshotRow = {
  id: string;
  page_id: string;
  name: string;
  snapshot_id: string;
  created_at: string;
};

type BaselineRow = {
  id: string;
  deck_id: string;
  created_by: string;
  created_at: string;
};

type BaselinePageRow = {
  baseline_id: string;
  page_id: string;
  document_id: string;
  snapshot_id: string;
};

function namedFromRow(row: NamedSnapshotRow): NamedSnapshot {
  return { id: row.id, pageId: row.page_id, name: row.name, snapshotId: row.snapshot_id, createdAt: row.created_at };
}

function baselineFromRow(row: BaselineRow): RecordingBaseline {
  const pages = getDb()
    .prepare("SELECT * FROM recording_baseline_pages WHERE baseline_id = ? ORDER BY rowid ASC")
    .all(row.id) as BaselinePageRow[];
  return {
    id: row.id,
    deckId: row.deck_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    pages: pages.map((page) => ({ pageId: page.page_id, documentId: page.document_id, snapshotId: page.snapshot_id })),
  };
}

function requirePage(deckId: string, pageId: string, userId: string, role: "USER" | "ADMIN") {
  const deck = getDeck(deckId, userId, role);
  const page = deck.pages.find((item) => item.id === pageId);
  if (!page) throw new HttpError(404, "Page not found");
  return { deck, page };
}

export function createNamedSnapshot(
  deckId: string,
  pageId: string,
  name: string,
  userId: string,
  role: "USER" | "ADMIN",
): NamedSnapshot {
  const { page } = requirePage(deckId, pageId, userId, role);
  const clean = name.trim();
  if (!clean) throw new HttpError(400, "Snapshot name is required");
  return transaction(() => {
    const version = createPinnedSnapshotFromDoc(page.documentId, userId, "named_snapshot");
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO named_snapshots (id, page_id, name, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, pageId, clean, version.id, createdAt);
    return namedFromRow(getDb().prepare("SELECT * FROM named_snapshots WHERE id = ?").get(id) as NamedSnapshotRow);
  });
}

export function listNamedSnapshots(
  deckId: string,
  pageId: string,
  userId: string,
  role: "USER" | "ADMIN",
): NamedSnapshot[] {
  requirePage(deckId, pageId, userId, role);
  const rows = getDb()
    .prepare("SELECT * FROM named_snapshots WHERE page_id = ? ORDER BY created_at DESC")
    .all(pageId) as NamedSnapshotRow[];
  return rows.map(namedFromRow);
}

function unpinIfUnused(snapshotId: string): void {
  const named = getDb().prepare("SELECT COUNT(*) AS count FROM named_snapshots WHERE snapshot_id = ?").get(snapshotId) as { count: number };
  const baseline = getDb().prepare("SELECT COUNT(*) AS count FROM recording_baseline_pages WHERE snapshot_id = ?").get(snapshotId) as { count: number };
  if (named.count === 0 && baseline.count === 0) {
    getDb().prepare("UPDATE document_versions SET is_pinned = 0 WHERE id = ?").run(snapshotId);
  }
}

export function deleteNamedSnapshot(
  deckId: string,
  pageId: string,
  namedSnapshotId: string,
  userId: string,
  role: "USER" | "ADMIN",
): void {
  requirePage(deckId, pageId, userId, role);
  const row = getDb()
    .prepare("SELECT * FROM named_snapshots WHERE id = ? AND page_id = ?")
    .get(namedSnapshotId, pageId) as NamedSnapshotRow | undefined;
  if (!row) throw new HttpError(404, "Named snapshot not found");
  transaction(() => {
    getDb().prepare("DELETE FROM named_snapshots WHERE id = ?").run(namedSnapshotId);
    unpinIfUnused(row.snapshot_id);
  });
}

export function setRecordingBaseline(
  deckId: string,
  userId: string,
  role: "USER" | "ADMIN",
): RecordingBaseline {
  const deck = getDeck(deckId, userId, role);
  return transaction(() => {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO recording_baselines (id, deck_id, created_by, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, deckId, userId, createdAt);
    for (const page of deck.pages) {
      const version = createPinnedSnapshotFromDoc(page.documentId, userId, "recording_baseline");
      getDb().prepare(
        "INSERT INTO recording_baseline_pages (baseline_id, page_id, document_id, snapshot_id) VALUES (?, ?, ?, ?)",
      ).run(id, page.id, page.documentId, version.id);
    }
    getDb().prepare("UPDATE decks SET active_recording_baseline_id = ?, updated_at = ? WHERE id = ?")
      .run(id, createdAt, deckId);
    return baselineFromRow(getDb().prepare("SELECT * FROM recording_baselines WHERE id = ?").get(id) as BaselineRow);
  });
}

export function listRecordingBaselines(
  deckId: string,
  userId: string,
  role: "USER" | "ADMIN",
): RecordingBaseline[] {
  getDeck(deckId, userId, role);
  const rows = getDb()
    .prepare("SELECT * FROM recording_baselines WHERE deck_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(deckId) as BaselineRow[];
  return rows.map(baselineFromRow);
}

export function getActiveRecordingBaseline(
  deckId: string,
  userId: string,
  role: "USER" | "ADMIN",
): RecordingBaseline | null {
  const deck = getDeck(deckId, userId, role);
  if (!deck.activeRecordingBaselineId) return null;
  const row = getDb().prepare("SELECT * FROM recording_baselines WHERE id = ? AND deck_id = ?")
    .get(deck.activeRecordingBaselineId, deckId) as BaselineRow | undefined;
  return row ? baselineFromRow(row) : null;
}

export type BaselineResetInput =
  | { scope: "all" }
  | { scope: "current"; pageId: string };

export interface BaselineResetResult {
  restoredPageIds: string[];
  skippedPageIds: string[];
}

export function resetRecordingBaseline(
  deckId: string,
  input: BaselineResetInput,
  userId: string,
  role: "USER" | "ADMIN",
): BaselineResetResult {
  const deck = getDeck(deckId, userId, role);
  const baseline = getActiveRecordingBaseline(deckId, userId, role);
  if (!baseline) throw new HttpError(409, "No active recording baseline");

  const baselinePages = input.scope === "current"
    ? baseline.pages.filter((page) => page.pageId === input.pageId)
    : baseline.pages;
  if (input.scope === "current" && baselinePages.length === 0) {
    return { restoredPageIds: [], skippedPageIds: [input.pageId] };
  }

  const currentById = new Map(deck.pages.map((page) => [page.id, page]));
  const targets: RecordingBaselinePage[] = [];
  const skippedPageIds: string[] = [];

  for (const baselinePage of baselinePages) {
    const current = currentById.get(baselinePage.pageId);
    if (!current || current.documentId !== baselinePage.documentId || !getDocumentRaw(baselinePage.documentId)) {
      skippedPageIds.push(baselinePage.pageId);
      continue;
    }
    const version = getVersion(baselinePage.snapshotId);
    if (!version || version.document_id !== baselinePage.documentId) {
      throw new HttpError(409, `Baseline snapshot is unavailable for page ${baselinePage.pageId}`);
    }
    if (hasActiveEditLease(baselinePage.documentId)) {
      throw new HttpError(409, `Cannot reset page ${baselinePage.pageId}: active edit lease`);
    }
    targets.push(baselinePage);
  }

  return transaction(() => {
    for (const target of targets) {
      restoreVersionWithoutLease(target.documentId, target.snapshotId, userId, role, false);
    }
    return { restoredPageIds: targets.map((target) => target.pageId), skippedPageIds };
  });
}
