import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import {
  getDocumentWithScene,
  renameDocument,
  softDelete,
  restoreDocument,
  documentToMeta,
  getDocumentRaw,
} from "@/lib/documents";
import { permanentDelete } from "@/lib/trash";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const { scene, permission } = getDocumentWithScene(id, user.id, user.role, adminMode);
    const doc = getDocumentRaw(id)!;
    const meta = documentToMeta(doc, user.id, user.role, adminMode);
    return json({ document: meta, scene, permission });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    if (typeof body.title !== "string" || !body.title.trim()) {
      return jsonError("title is required", 400);
    }
    const renamed = renameDocument(id, body.title.trim(), user.id, user.role, adminMode);
    return json({ document: documentToMeta(renamed, user.id, user.role, adminMode) });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const url = new URL(req.url);
    const permanent = url.searchParams.get("permanent") === "1";
    if (permanent) {
      permanentDelete(id, user.id, user.role, adminMode);
    } else {
      softDelete(id, user.id, user.role);
    }
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  // Support operation dispatch for restore via query ?action=restore.
  try {
    const { id } = await params;
    const user = requireUser(req);
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "restore") {
      restoreDocument(id, user.id, user.role);
      return json({ ok: true });
    }
    return jsonError("Unsupported action", 400);
  } catch (err) {
    return handleError(err);
  }
}