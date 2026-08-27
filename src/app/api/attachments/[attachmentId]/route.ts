import { handleError } from "@/lib/http";
import { optionalUser } from "@/lib/http";
import { getAttachmentById, readAttachmentBytes, resolveAttachmentFilesystem } from "@/lib/attachments";
import { resolvePermission } from "@/lib/documents";
import { getValidShareLinkByToken } from "@/lib/share_links";
import { statSync } from "node:fs";

interface Ctx {
  params: { attachmentId: string };
}

/**
 * Serve a stored attachment. Authorized either by an authenticated user with
 * read access to the owning document, or by a valid share token (anonymous
 * read-only viewer) for that document.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const row = getAttachmentById(params.attachmentId);
    if (!row) {
      return new Response("Not found", { status: 404 });
    }
    const docId = row.document_id;

    const user = optionalUser(req);
    let allowed = false;
    if (user) {
      const perm = resolvePermission(docId, user.id, user.role, user.role === "ADMIN");
      allowed = perm !== undefined;
    }
    if (!allowed) {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (token) {
        const link = getValidShareLinkByToken(token);
        if (link && link.document_id === docId) {
          allowed = true;
        }
      }
    }
    if (!allowed) {
      return new Response("Forbidden", { status: 403 });
    }

    const bytes = readAttachmentBytes(row);
    const size = statSync(resolveAttachmentFilesystem(row)).size;
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": row.mime_type || "application/octet-stream",
        "Content-Length": String(size),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}