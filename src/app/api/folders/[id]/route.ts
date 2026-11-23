import { handleError, json, readJson, requireUser } from "@/lib/http";
import { deleteFolder, FolderError, updateFolder } from "@/lib/folders";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    const { id } = await context.params;
    const body = await readJson(req);
    const folder = updateFolder(user.id, id, {
      name: body.name,
      parentId: body.parentId,
    });
    return json({ folder });
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    const { id } = await context.params;
    const result = deleteFolder(user.id, id);
    return json({ ok: true, reparentedTo: result.reparentedTo });
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}
