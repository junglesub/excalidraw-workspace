import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  handleError,
  json,
  jsonError,
  readJson,
  requireUser,
} from "@/lib/http";
import {
  getByUsername,
  createSession,
  toPublicUser,
  bootstrapAdmin,
  deleteExpiredSessions,
} from "@/lib/users";
import { verifyPassword } from "@/lib/passwords";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    bootstrapAdmin();
    deleteExpiredSessions();
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      return jsonError("Username and password are required", 400);
    }
    const user = getByUsername(username);
    if (!user || user.is_active !== 1 || !verifyPassword(password, user.password_hash)) {
      return jsonError("Invalid credentials", 401);
    }
    const { token } = createSession(user.id);
    cookies().set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return json({ user: toPublicUser(user) });
  } catch (err) {
    return handleError(err);
  }
}

export function GET(req: Request) {
  try {
    const user = requireUser(req);
    return json({ user: toPublicUser(user) });
  } catch (err) {
    return handleError(err);
  }
}