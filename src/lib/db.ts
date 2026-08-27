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
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id, version_number);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  mime_type   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  sha256      TEXT,
  created_at  TEXT NOT NULL
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
`;

export function initializeSchema(database: DatabaseSync): void {
  database.exec(SCHEMA_SQL);
}