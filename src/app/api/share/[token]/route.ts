import { handleError, json } from "@/lib/http";
import { getDocumentRaw } from "@/lib/documents";
import { jsonToScene } from "@/lib/types";

interface Ctx {
  params: { token: string };
}

/**
 * Anonymous read-only access to a document via a share token.
 * Requires a valid, un-expired, active link.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    // Re-export guard from share_links.
    const { requireValidShareToken: requireToken } = await import("@/lib/share_links");
    const link = await requireToken(params.token);
    const doc = getDocumentRaw(link.document_id);
    if (!doc || doc.deleted_at) {
      return json({ error: "Document not found" }, 404);
    }
    return json({
      document: {
        id: doc.id,
        title: doc.title,
        updated_at: doc.updated_at,
      },
      scene: jsonToScene(doc.scene),
      permission: "VIEWER",
      shareToken: params.token,
    });
  } catch (err) {
    return handleError(err);
  }
}