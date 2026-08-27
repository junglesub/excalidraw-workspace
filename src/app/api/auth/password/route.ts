import { handleError, json, readJson, requireUser, findSessionToken } from "@/lib/http";
import { getById, setPassword, deleteSessionsForUserExcept } from "@/lib/users";
import { verifyPassword } from "@/lib/passwords";

export async function PATCH(req: Request) {
  try {
    const user = requireUser(req);
    const body = await readJson(req);
    const current = String(body.currentPassword || "");
    const next = String(body.newPassword || "");
    if (!next) {
      return json({ error: "newPassword is required" }, 400);
    }
    if (!verifyPassword(current, getById(user.id)!.password_hash)) {
      return json({ error: "Current password is incorrect" }, 401);
    }
    setPassword(user.id, next);
    const currentToken = findSessionToken(req);
    deleteSessionsForUserExcept(user.id, currentToken);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}