import { getUserBySessionToken, createSession } from "./users";
import type { UserRow } from "./types";

export const SESSION_COOKIE = "pew_session";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function findSessionToken(req: Request): string | undefined {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE];
}

export interface Authed {
  user: UserRow;
}

/**
 * Resolve the current authenticated user from the request cookie.
 * Throws HttpError(401) if missing/expired/inactive.
 */
export function requireUser(req: Request): UserRow {
  const token = findSessionToken(req);
  if (!token) {
    throw new HttpError(401, "Authentication required");
  }
  const user = getUserBySessionToken(token);
  if (!user) {
    throw new HttpError(401, "Session expired or invalid");
  }
  return user;
}

/** Optional auth: return the user or undefined instead of throwing. */
export function optionalUser(req: Request): UserRow | undefined {
  const token = findSessionToken(req);
  if (!token) return undefined;
  return getUserBySessionToken(token);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function buildCookieValue(raw: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function jsonError(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export function handleError(err: unknown): Response {
  if (err instanceof HttpError) {
    return jsonError(err.message, err.status);
  }
  console.error("[api] unhandled error", err);
  return jsonError("Internal Server Error", 500);
}

/** Parse a JSON request body; throws 400 on malformed input. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Ensure the passed user is an ADMIN or throw 403. */
export function requireAdmin(user: { role: string }): void {
  if (user.role !== "ADMIN") {
    throw new HttpError(403, "Admin privileges required");
  }
}

/** Resolve adminMode from query string (admins opt in explicitly). */
export function adminModeFrom(req: Request, user: { role: string }): boolean {
  const url = new URL(req.url);
  const flag = url.searchParams.get("adminMode");
  return user.role === "ADMIN" && flag === "1";
}