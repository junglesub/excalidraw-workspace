import { handleError, json, readJson, requireUser } from "@/lib/http";
import { createDocument, listMyDocuments, documentToMeta, getDocumentRaw } from "@/lib/documents";
import { jsonToScene, emptyScene } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    return json({ documents: listMyDocuments(user.id) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const body = await readJson(req);
    const title = String(body.title || "Untitled");
    let scene = emptyScene();
    if (body.scene && typeof body.scene === "object") {
      scene = jsonToScene(JSON.stringify(body.scene));
    }
    const doc = createDocument(user.id, scene, title);
    const meta = documentToMeta(getDocumentRaw(doc.id)!, user.id, user.role, false);
    return json({ document: meta }, 201);
  } catch (err) {
    return handleError(err);
  }
}