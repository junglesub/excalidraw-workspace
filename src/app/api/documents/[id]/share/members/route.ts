import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import {
  getDocumentRaw,
  addMember,
  removeMember,
  listMembers,
} from "@/lib/documents";
import { getByUsername } from "@/lib/users";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Owner-only: list users the document is shared with. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const doc = getDocumentRaw(id);
    if (!doc || doc.deleted_at) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can view members", 403);
    }
    return json({ members: listMembers(id) });
  } catch (err) {
    return handleError(err);
  }
}

/** Owner-only: share the document with a user as VIEWER. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const doc = getDocumentRaw(id);
    if (!doc || doc.deleted_at) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can share this document", 403);
    }
    const body = await readJson(req);
    const targetUser = getByUsername(String(body.username || "").trim());
    if (!targetUser) return jsonError("Target user not found", 404);
    if (targetUser.id === doc.owner_id) {
      return jsonError("The document owner cannot be added as a member", 400);
    }
    addMember(id, targetUser.id, "VIEWER");
    return json({ members: listMembers(id) }, 201);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const url = new URL(req.url);
    const targetId = url.searchParams.get("userId");
    if (!targetId) return jsonError("userId is required", 400);
    const doc = getDocumentRaw(id);
    if (!doc || doc.deleted_at) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can unshare", 403);
    }
    if (targetId === doc.owner_id) return jsonError("Cannot remove the owner", 400);
    removeMember(id, targetId);
    return json({ members: listMembers(id) });
  } catch (err) {
    return handleError(err);
  }
}