import { getDb, transaction } from "./db";
import { config } from "./config";
import type { PublicUser, SessionRow, UserRow } from "./types";
import { hashPassword } from "./passwords";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    is_active: u.is_active === 1,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export function createUser(
  username: string,
  plainPassword: string,
  role: "USER" | "ADMIN" = "USER",
): UserRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = hashPassword(plainPassword);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, username, passwordHash, role, now, now);
  return getById(id)!;
}

export function getById(id: string): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
}

export function getByUsername(username: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
    .get(username) as UserRow | undefined;
}

export function listUsers(): UserRow[] {
  return getDb().prepare("SELECT * FROM users ORDER BY created_at ASC").all() as UserRow[];
}

export function setActive(id: string, active: boolean): void {
  getDb()
    .prepare("UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?")
    .run(active ? 1 : 0, new Date().toISOString(), id);
}

export function setUsername(id: string, username: string): void {
  getDb()
    .prepare("UPDATE users SET username = ?, updated_at = ? WHERE id = ?")
    .run(username, new Date().toISOString(), id);
}

export function setPassword(id: string, plainPassword: string): void {
  getDb()
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(plainPassword), new Date().toISOString(), id);
}

export function deleteUser(id: string): void {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function hasAnyAdmin(): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN'")
    .get() as { c: number };
  return row.c > 0;
}

export function countUsers(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  return row.c;
}

export function bootstrapAdmin(): void {
  const cfg = config();
  const isProd = process.env.NODE_ENV === "production";

  if (hasAnyAdmin()) {
    return; // an admin already exists elsewhere; do not create a second bootstrap admin
  }

  if (isProd) {
    if (!cfg.adminUsername || !cfg.adminPassword) {
      throw new Error(
        "Production bootstrap error: ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required to bootstrap the initial admin account.",
      );
    }
    if (cfg.adminPassword === "admin1234!" || cfg.adminPassword.length < 8) {
      throw new Error(
        "Production bootstrap error: ADMIN_PASSWORD is using an insecure default or is shorter than 8 characters.",
      );
    }
  } else {
    if (!cfg.adminUsername || !cfg.adminPassword) {
      return;
    }
  }

  const existing = getByUsername(cfg.adminUsername);
  if (existing && existing.role === "ADMIN") {
    return;
  }
  createUser(cfg.adminUsername, cfg.adminPassword, "ADMIN");
}

/**
 * Create a new session token and return both the token and the row.
 * Active existing sessions for the user are left intact (multi-device allowed).
 */
export function createSession(userId: string): { session: SessionRow; token: string } {
  const db = getDb();
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, token, expiresAt, now);
  return { session: { id, user_id: userId, token, expires_at: expiresAt, created_at: now }, token };
}

export function getUserBySessionToken(token: string): UserRow | undefined {
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?")
    .get(token, new Date().toISOString()) as SessionRow | undefined;
  if (!session) {
    return undefined;
  }
  const user = getById(session.user_id);
  if (!user || user.is_active !== 1) {
    return undefined;
  }
  return user;
}

export function deleteSession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteSessionsForUser(userId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function deleteSessionsForUserExcept(userId: string, keepToken?: string): void {
  if (keepToken) {
    getDb().prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepToken);
  } else {
    getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function deleteExpiredSessions(): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}