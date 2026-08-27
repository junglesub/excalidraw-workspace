import { handleError } from "@/lib/http";
import { optionalUser } from "@/lib/http";
import { getAttachment, readAttachmentBytes, resolveAttachmentFilesystem, SAFE_ID_REGEX } from "@/lib/attachments";
import { resolvePermission } from "@/lib/documents";
import { getValidShareLinkByToken } from "@/lib/share_links";
import { getDb } from "@/lib/db";
import type { AttachmentRow } from "@/lib/types";
import { statSync } from "node:fs";

interface Ctx {
  params: Promise<{ attachmentId: string }>;
}

/**
 * Serve a stored attachment. Authorized either by an authenticated user with
 * read access to the owning document, or by a valid share token (anonymous
 * read-only viewer) for that document.
 *
 * Scoped lookup via optional ?docId=<docId> query parameter prevents ambiguity
 * when the same attachment ID / Excalidraw fileId exists in different documents.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { attachmentId } = await params;
    if (!SAFE_ID_REGEX.test(attachmentId)) {
      return new Response("Invalid attachment ID", { status: 400 });
    }

    const url = new URL(req.url);
    const docIdParam = url.searchParams.get("docId");

    let row: AttachmentRow | undefined;
    if (docIdParam) {
      if (!SAFE_ID_REGEX.test(docIdParam)) {
        return new Response("Invalid document ID", { status: 400 });
      }
      row = getAttachment(docIdParam, attachmentId);
    } else {
      const db = getDb();
      const rows = db
        .prepare("SELECT * FROM attachments WHERE id = ?")
        .all(attachmentId) as AttachmentRow[];
      if (rows.length === 0) {
        return new Response("Not found", { status: 404 });
      }
      if (rows.length === 1) {
        row = rows[0];
      } else {
        // Multiple documents have an attachment with this ID; disambiguate using caller permissions
        const user = optionalUser(req);
        const token = url.searchParams.get("token");
        const authorizedRows = rows.filter((r) => {
          if (user) {
            const perm = resolvePermission(r.document_id, user.id, user.role, user.role === "ADMIN");
            if (perm !== undefined) return true;
          }
          if (token) {
            const link = getValidShareLinkByToken(token);
            if (link && link.document_id === r.document_id) return true;
          }
          return false;
        });

        if (authorizedRows.length === 1) {
          row = authorizedRows[0];
        } else if (authorizedRows.length > 1) {
          return new Response(
            "Ambiguous attachment ID across multiple accessible documents; please provide docId query parameter",
            { status: 400 },
          );
        } else {
          return new Response("Forbidden", { status: 403 });
        }
      }
    }

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