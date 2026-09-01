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
    database.exec("DELETE FROM document_edit_leases;");
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
  origin         TEXT
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
    const cols = database.prepare("PRAGMA table_info(document_versions)").all() as { name: string }[];
    const hasOrigin = cols.some((c) => c.name === "origin");
    if (!hasOrigin) {
      database.exec("ALTER TABLE document_versions ADD COLUMN origin TEXT");
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