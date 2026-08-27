import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { transferOwnership, documentToMeta, getDocumentRaw } from "@/lib/documents";

interface Ctx {
  params: { id: string };
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    let targetUserId = String(body.userId || "");
    if (!targetUserId && body.username) {
      const { getByUsername } = await import("@/lib/users");
      const u = getByUsername(String(body.username).trim());
      if (!u) return jsonError("Target user not found", 404);
      targetUserId = u.id;
    }
    if (!targetUserId) return jsonError("userId or username is required", 400);
    const doc = transferOwnership(params.id, targetUserId, user.id, user.role);
    return json({ document: documentToMeta(getDocumentRaw(doc.id)!, user.id, user.role, adminMode) });
  } catch (err) {
    return handleError(err);
  }
}