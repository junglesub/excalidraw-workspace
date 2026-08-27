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
  params: { id: string };
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const { scene, permission } = getDocumentWithScene(params.id, user.id, user.role, adminMode);
    const doc = getDocumentRaw(params.id)!;
    const meta = documentToMeta(doc, user.id, user.role, adminMode);
    return json({ document: meta, scene, permission });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    if (typeof body.title !== "string" || !body.title.trim()) {
      return jsonError("title is required", 400);
    }
    const renamed = renameDocument(params.id, body.title.trim(), user.id, user.role, adminMode);
    return json({ document: documentToMeta(renamed, user.id, user.role, adminMode) });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const url = new URL(req.url);
    const permanent = url.searchParams.get("permanent") === "1";
    if (permanent) {
      permanentDelete(params.id, user.id, user.role, adminMode);
    } else {
      softDelete(params.id, user.id, user.role);
    }
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  // Support operation dispatch for restore via query ?action=restore.
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "restore") {
      restoreDocument(params.id, user.id, user.role);
      return json({ ok: true });
    }
    return jsonError("Unsupported action", 400);
  } catch (err) {
    return handleError(err);
  }
}