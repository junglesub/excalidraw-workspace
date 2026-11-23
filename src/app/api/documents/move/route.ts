import { handleError, json, readJson, requireUser } from "@/lib/http";
import { FolderError, moveDocumentsToFolder, parseDestinationFolderId } from "@/lib/folders";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const user = requireUser(req);
    const body = await readJson(req);
    const folderId = parseDestinationFolderId(body.folderId, { required: true });
    const result = moveDocumentsToFolder(user.id, body.documentIds, folderId);
    return json({ ok: result.failed.length === 0, ...result });
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}
