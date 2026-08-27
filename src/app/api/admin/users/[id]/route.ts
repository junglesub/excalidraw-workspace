import { handleError, json, jsonError, readJson, requireAdmin, requireUser } from "@/lib/http";
import { getById, setActive, setPassword, deleteUser, toPublicUser, deleteSessionsForUser } from "@/lib/users";

interface Ctx {
  params: { id: string };
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const admin = requireUser(req);
    requireAdmin(admin);
    const target = getById(params.id);
    if (!target) return jsonError("User not found", 404);
    if (target.id === admin.id) {
      return jsonError("You cannot disable or change your own account here", 400);
    }
    const body = await readJson(req);
    if (typeof body.is_active === "boolean") {
      setActive(target.id, body.is_active);
      if (!body.is_active) deleteSessionsForUser(target.id); // revoke sessions when disabled
    }
    if (typeof body.password === "string" && body.password.length > 0) {
      setPassword(target.id, body.password);
      deleteSessionsForUser(target.id);
    }
    return json({ user: toPublicUser(getById(target.id)!) });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const admin = requireUser(req);
    requireAdmin(admin);
    const target = getById(params.id);
    if (!target) return jsonError("User not found", 404);
    if (target.id === admin.id) {
      return jsonError("You cannot delete your own account", 400);
    }
    deleteUser(target.id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}