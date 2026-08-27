import { handleError, json, jsonError, requireUser } from "@/lib/http";
import { createDocument, documentToMeta, getDocumentRaw } from "@/lib/documents";
import { importExcalidrawJson } from "@/lib/exc_io";

/**
 * Import a .excalidraw file as a brand new document owned by the caller.
 * Expects a multipart form field `file` containing the JSON payload.
 */
export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("A .excalidraw file is required", 400);
    }
    const content = await file.text();
    const scene = importExcalidrawJson(content);
    const title = form.get("title")
      ? String(form.get("title"))
      : (file.name || "Imported").replace(/\.excalidraw$/i, "").replace(/[^\w.\- ]+/g, "_") || "Imported";
    const doc = createDocument(user.id, scene, title);
    const meta = documentToMeta(getDocumentRaw(doc.id)!, user.id, user.role, false);
    return json({ document: meta }, 201);
  } catch (err) {
    return handleError(err);
  }
}