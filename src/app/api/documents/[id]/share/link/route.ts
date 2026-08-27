import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { getDocumentRaw } from "@/lib/documents";
import {
  createOrReplaceShareLink,
  getShareLinkByDocument,
  deactivateShareLink,
  summarizeShareLink,
} from "@/lib/share_links";

interface Ctx {
  params: { id: string };
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const doc = getDocumentRaw(params.id);
    if (!doc) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can manage share links", 403);
    }
    const link = getShareLinkByDocument(params.id);
    return json({ link: link ? summarizeShareLink(link) : null });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const doc = getDocumentRaw(params.id);
    if (!doc) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can create share links", 403);
    }
    const body = await readJson(req);
    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt
        ? new Date(body.expiresAt).toISOString()
        : null;
    if (typeof body.expiresAt === "string" && body.expiresAt && isNaN(new Date(body.expiresAt).getTime())) {
      return jsonError("Invalid expiration date", 400);
    }
    const link = createOrReplaceShareLink(params.id, expiresAt, "VIEWER");
    return json({ link: summarizeShareLink(link) }, 201);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const doc = getDocumentRaw(params.id);
    if (!doc) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can deactivate share links", 403);
    }
    deactivateShareLink(params.id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}