import { getUserBySessionToken } from "./users";
import type { UserRow } from "./types";

export const SESSION_COOKIE = "pew_session";
export const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024; // 25 MB bounded guard for scenes & thumbnails

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

export function buildCookieValue(raw: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${secure}`;
}

export function buildClearCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
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

/** Parse a JSON request body with bounded size guard; throws 413 on oversized and 400 on malformed input. */
export async function readJson(
  req: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const cl = req.headers.get("content-length");
  if (cl) {
    const len = Number.parseInt(cl, 10);
    if (!Number.isNaN(len) && len > maxBytes) {
      throw new HttpError(413, `Request body exceeds maximum size of ${maxBytes} bytes`);
    }
  }

  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new HttpError(413, `Request body exceeds maximum size of ${maxBytes} bytes`);
    }
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
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