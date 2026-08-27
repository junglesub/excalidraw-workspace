import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { Permission, ShareLinkRow } from "./types";
import { HttpError } from "./http";

/**
 * Share-link management. A document has at most one active, non-expired link;
 * regenerating rotates the token (old token immediately invalidated).
 */
export function createOrReplaceShareLink(
  documentId: string,
  expiresAt: string | null,
  permission: Permission = "VIEWER",
): ShareLinkRow {
  const db = getDb();
  const now = new Date().toISOString();

  // Deactivate any existing link first so the old token becomes invalid.
  db.prepare("UPDATE share_links SET is_active = 0 WHERE document_id = ?").run(documentId);

  const existing = db
    .prepare("SELECT * FROM share_links WHERE document_id = ?")
    .get(documentId) as ShareLinkRow | undefined;
  const token = randomUUID().replace(/-/g, "");
  if (existing) {
    db.prepare(
      "UPDATE share_links SET token = ?, permission = ?, expires_at = ?, is_active = 1 WHERE document_id = ?",
    ).run(token, permission, expiresAt, documentId);
    return getShareLinkByDocument(documentId)!;
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO share_links (id, document_id, token, permission, expires_at, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
  ).run(id, documentId, token, permission, expiresAt, now);
  return getShareLinkByDocument(documentId)!;
}

export function getShareLinkByDocument(documentId: string): ShareLinkRow | undefined {
  return getDb().prepare("SELECT * FROM share_links WHERE document_id = ?").get(documentId) as
    | ShareLinkRow
    | undefined;
}

function isLive(row: ShareLinkRow): boolean {
  if (row.is_active !== 1) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false;
  return true;
}

export function getActiveShareLink(documentId: string): ShareLinkRow | undefined {
  const row = getShareLinkByDocument(documentId);
  return row && isLive(row) ? row : undefined;
}

export function resolveShareLinkByToken(token: string): ShareLinkRow | undefined {
  return getDb().prepare("SELECT * FROM share_links WHERE token = ?").get(token) as
    | ShareLinkRow
    | undefined;
}

export function getValidShareLinkByToken(token: string): ShareLinkRow | undefined {
  const row = resolveShareLinkByToken(token);
  return row && isLive(row) ? row : undefined;
}

export function requireValidShareToken(token: string): ShareLinkRow {
  const link = getValidShareLinkByToken(token);
  if (!link) throw new HttpError(403, "This share link is invalid or has expired");
  return link;
}

export function deactivateShareLink(documentId: string): void {
  getDb().prepare("UPDATE share_links SET is_active = 0 WHERE document_id = ?").run(documentId);
}

export interface ShareLinkSummary {
  document_id: string;
  token: string;
  permission: Permission;
  expires_at: string | null;
  is_active: boolean;
  url: string;
}

export function summarizeShareLink(row: ShareLinkRow): ShareLinkSummary {
  return {
    document_id: row.document_id,
    token: row.token,
    permission: row.permission,
    expires_at: row.expires_at,
    is_active: row.is_active === 1,
    url: `/share/${row.token}`,
  };
}