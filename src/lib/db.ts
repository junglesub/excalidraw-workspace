import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

/**
 * Opened SQLite database (Node built-in `node:sqlite`).
 * Foreign keys are enabled and the journal is set to WAL for durability and
 * concurrent-read support.
 */
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    const cfg = config();
    db = new NodeDatabaseSync(cfg.dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    initializeSchema(db);
    try {
      // Lazy load to avoid circular dependency
      const { bootstrapAdmin } = require("./users");
      bootstrapAdmin();
    } catch {
      // ignore
    }
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Re-open a fresh connection and wipe tables (used by tests between isolated scenarios). */
export function resetDb(): DatabaseSync {
  const database = getDb();
  try {
    database.exec("DELETE FROM recording_baseline_pages;");
    database.exec("DELETE FROM recording_baselines;");
    database.exec("DELETE FROM named_snapshots;");
    database.exec("DELETE FROM deck_pages;");
    database.exec("DELETE FROM decks;");
    database.exec("DELETE FROM deck_edit_leases; DELETE FROM document_edit_leases;");
    database.exec("DELETE FROM document_versions;");
    database.exec("DELETE FROM document_members;");
    database.exec("DELETE FROM share_links;");
    database.exec("DELETE FROM attachments;");
    database.exec("DELETE FROM documents;");
    database.exec("DELETE FROM sessions;");
    database.exec("DELETE FROM users;");
  } catch {
    // ignore
  }
  return database;
}

/**
 * Run a function inside an atomic SQL transaction. Any throw causes a
 * rollback so the database is never left in a partially-applied state.
 */
export function transaction<T>(fn: () => T): T {
  const database = getDb();
  if ((database as DatabaseSync & { isTransaction?: boolean }).isTransaction) {
    return fn();
  }
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    database.exec("COMMIT;");
    return result;
  } catch (err) {
    database.exec("ROLLBACK;");
    throw err;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  presentation_laser_settings TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scene          TEXT NOT NULL DEFAULT '{}',
  thumbnail_path TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

CREATE TABLE IF NOT EXISTS document_members (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL CHECK (permission IN ('OWNER','EDITOR','VIEWER')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON document_members(user_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  scene          TEXT NOT NULL,
  thumbnail_path TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  origin         TEXT,
  is_pinned      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id, version_number);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  mime_type   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  sha256      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (document_id, id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_doc ON attachments(document_id);

CREATE TABLE IF NOT EXISTS share_links (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  permission  TEXT NOT NULL DEFAULT 'VIEWER' CHECK (permission IN ('OWNER','EDITOR','VIEWER')),
  expires_at  TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);

CREATE TABLE IF NOT EXISTS decks (
  id                           TEXT PRIMARY KEY,
  title                        TEXT NOT NULL,
  owner_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aspect_ratio                 TEXT NOT NULL CHECK (aspect_ratio IN ('16:9','9:16')),
  active_recording_baseline_id TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decks_owner ON decks(owner_id, updated_at);

CREATE TABLE IF NOT EXISTS deck_pages (
  id          TEXT PRIMARY KEY,
  deck_id     TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  page_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (deck_id, page_order)
);
CREATE INDEX IF NOT EXISTS idx_deck_pages_deck ON deck_pages(deck_id, page_order);

CREATE TABLE IF NOT EXISTS named_snapshots (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES deck_pages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_named_snapshots_page ON named_snapshots(page_id, created_at);

CREATE TABLE IF NOT EXISTS recording_baselines (
  id         TEXT PRIMARY KEY,
  deck_id    TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recording_baselines_deck ON recording_baselines(deck_id, created_at);

CREATE TABLE IF NOT EXISTS recording_baseline_pages (
  baseline_id TEXT NOT NULL REFERENCES recording_baselines(id) ON DELETE CASCADE,
  page_id     TEXT NOT NULL,
  document_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  PRIMARY KEY (baseline_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_recording_baseline_pages_snapshot ON recording_baseline_pages(snapshot_id);

CREATE TABLE IF NOT EXISTS deck_edit_leases (
  deck_id                 TEXT PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
  holder_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  holder_client_id        TEXT,
  lease_token             TEXT,
  generation              INTEGER NOT NULL,
  acquired_at             TEXT,
  heartbeat_at            TEXT,
  expires_at              TEXT,
  takeover_request_id     TEXT,
  takeover_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  takeover_client_id      TEXT,
  takeover_lease_token    TEXT,
  takeover_requested_at   TEXT,
  takeover_deadline_at    TEXT
);

CREATE TABLE IF NOT EXISTS document_edit_leases (
  document_id             TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  holder_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  holder_client_id        TEXT,
  lease_token             TEXT,
  generation              INTEGER NOT NULL,
  acquired_at             TEXT,
  heartbeat_at            TEXT,
  expires_at              TEXT,
  takeover_request_id     TEXT,
  takeover_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  takeover_client_id      TEXT,
  takeover_lease_token    TEXT,
  takeover_requested_at   TEXT,
  takeover_deadline_at    TEXT
);
`;

export function initializeSchema(database: DatabaseSync): void {
  database.exec(SCHEMA_SQL);
  try {
    const userCols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (!userCols.some((c) => c.name === "presentation_laser_settings")) {
      database.exec("ALTER TABLE users ADD COLUMN presentation_laser_settings TEXT NOT NULL DEFAULT '{}'");
    }
  } catch (err) {
    console.error("Failed to migrate users presentation_laser_settings column:", err);
  }
  try {
    const cols = database.prepare("PRAGMA table_info(document_versions)").all() as { name: string }[];
    const hasOrigin = cols.some((c) => c.name === "origin");
    if (!hasOrigin) {
      database.exec("ALTER TABLE document_versions ADD COLUMN origin TEXT");
    }
    const hasPinned = cols.some((c) => c.name === "is_pinned");
    if (!hasPinned) {
      database.exec("ALTER TABLE document_versions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
    }
  } catch (err) {
    console.error("Failed to migrate document_versions origin column:", err);
  }
  try {
    const info = database.prepare("PRAGMA table_info(attachments)").all() as { name: string; pk: number }[];
    const docIdCol = info.find((c) => c.name === "document_id");
    // If table was created with old single PK (pk=0 for document_id), migrate to composite PK (document_id, id)
    if (info.length > 0 && docIdCol && docIdCol.pk === 0) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS attachments_v2 (
          id          TEXT NOT NULL,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          file_name   TEXT NOT NULL,
          file_size   INTEGER NOT NULL,
          mime_type   TEXT NOT NULL,
          file_path   TEXT NOT NULL,
          sha256      TEXT,
          created_at  TEXT NOT NULL,
          PRIMARY KEY (document_id, id)
        );
        INSERT OR IGNORE INTO attachments_v2 SELECT * FROM attachments;
        DROP TABLE attachments;
        ALTER TABLE attachments_v2 RENAME TO attachments;
        CREATE INDEX IF NOT EXISTS idx_attachments_doc ON attachments(document_id);
      `);
    }
  } catch (err) {
    console.error("Failed to migrate attachments table schema:", err);
  }
}