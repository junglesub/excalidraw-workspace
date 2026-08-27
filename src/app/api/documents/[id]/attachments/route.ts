import { handleError, json, jsonError, requireUser } from "@/lib/http";
import { requireWrite } from "@/lib/documents";
import { storeAttachment, listAttachments, attachUrl } from "@/lib/attachments";

interface Ctx {
  params: { id: string };
}

/** Upload an attachment (image) linked to a document. Requires write access. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    requireWrite(params.id, user.id, user.role, false);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("A file is required", 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) {
      return jsonError("Empty file", 400);
    }
    const mime = file.type || "application/octet-stream";
    const row = storeAttachment(params.id, file.name || "file", mime, buf);
    const others = listAttachments(params.id);
    return json(
      { attachment: { ...row, url: attachUrl(row.id, params.id) }, attachments: others },
      201,
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    requireWrite(params.id, user.id, user.role, false);
    const atts = listAttachments(params.id);
    return json({
      attachments: atts.map((a) => ({ ...a, url: attachUrl(a.id, params.id) })),
    });
  } catch (err) {
    return handleError(err);
  }
}