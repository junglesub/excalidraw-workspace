import { handleError, json, readJson, requireUser } from "@/lib/http";
import { FolderError, moveDeckToFolder, parseDestinationFolderId } from "@/lib/folders";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    const { id } = await context.params;
    const body = await readJson(req);
    const folderId = parseDestinationFolderId(body.folderId, { required: true });
    moveDeckToFolder(user.id, id, folderId);
    return json({ ok: true, folderId });
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}
