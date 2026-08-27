import { handleError, json, jsonError, readJson, requireAdmin, requireUser } from "@/lib/http";
import {
  createUser,
  listUsers,
  toPublicUser,
  getByUsername,
} from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    requireAdmin(user);
    return json({ users: listUsers().map(toPublicUser) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const admin = requireUser(req);
    requireAdmin(admin);
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = body.role === "ADMIN" ? "ADMIN" : "USER";
    if (!username || !password) {
      return jsonError("Username and password are required", 400);
    }
    if (getByUsername(username)) {
      return jsonError("Username already exists", 409);
    }
    const created = createUser(username, password, role);
    return json({ user: toPublicUser(created) }, 201);
  } catch (err) {
    return handleError(err);
  }
}