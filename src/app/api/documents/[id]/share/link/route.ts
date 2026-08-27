import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { getDocumentRaw } from "@/lib/documents";
import {
  createOrReplaceShareLink,
  getShareLinkByDocument,
  deactivateShareLink,
  summarizeShareLink,
} from "@/lib/share_links";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const doc = getDocumentRaw(id);
    if (!doc || doc.deleted_at) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can manage share links", 403);
    }
    const link = getShareLinkByDocument(id);
    return json({ link: link ? summarizeShareLink(link) : null });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const doc = getDocumentRaw(id);
    if (!doc || doc.deleted_at) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can create share links", 403);
    }
    const body = await readJson(req);
    let expiresAt: string | null = null;
    if (typeof body.expiresAt === "string" && body.expiresAt.trim().length > 0) {
      const d = new Date(body.expiresAt);
      if (isNaN(d.getTime())) {
        return jsonError("Invalid expiration date", 400);
      }
      expiresAt = d.toISOString();
    }
    const link = createOrReplaceShareLink(id, expiresAt, "VIEWER");
    return json({ link: summarizeShareLink(link) }, 201);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const doc = getDocumentRaw(id);
    if (!doc || doc.deleted_at) return jsonError("Document not found", 404);
    if (doc.owner_id !== user.id && user.role !== "ADMIN") {
      return jsonError("Only the owner can deactivate share links", 403);
    }
    deactivateShareLink(id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}