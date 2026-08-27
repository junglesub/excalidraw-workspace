import { handleError, json, jsonError, requireUser } from "@/lib/http";
import { requireWrite, requireRead } from "@/lib/documents";
import { storeAttachment, listAttachments, attachUrl, MAX_ATTACHMENT_BYTES } from "@/lib/attachments";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Upload an attachment (image) linked to a document. Requires write access. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    requireWrite(id, user.id, user.role, false);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("A file is required", 400);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return jsonError("Attachment exceeds maximum size limit of 25MB", 413);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) {
      return jsonError("Empty file", 400);
    }
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      return jsonError("Attachment exceeds maximum size limit of 25MB", 413);
    }
    const mime = file.type || "application/octet-stream";
    const fileIdParam = form.get("fileId");
    const customFileId = typeof fileIdParam === "string" && fileIdParam.trim() ? fileIdParam.trim() : undefined;

    const row = storeAttachment(id, file.name || "file", mime, buf, customFileId);
    const others = listAttachments(id);
    return json(
      { attachment: { ...row, url: attachUrl(row.id, id) }, attachments: others },
      row.isNew ? 201 : 200,
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    requireRead(id, user.id, user.role, false);
    const atts = listAttachments(id);
    return json({
      attachments: atts.map((a) => ({ ...a, url: attachUrl(a.id, id) })),
    });
  } catch (err) {
    return handleError(err);
  }
}