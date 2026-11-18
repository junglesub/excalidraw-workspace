import { handleError, json, readJson, requireUser } from "@/lib/http";
import { deleteFolder, FolderError, moveFolder, renameFolder } from "@/lib/folders";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    const { id } = await context.params;
    const body = await readJson(req);

    let folder = null;
    if (body.name !== undefined) {
      folder = renameFolder(user.id, id, body.name);
    }
    if (body.parentId !== undefined) {
      const targetParentId =
        typeof body.parentId === "string" && body.parentId.length > 0 ? body.parentId : null;
      folder = moveFolder(user.id, id, targetParentId);
    }
    if (!folder) {
      return json({ error: "No valid update fields provided" }, 400);
    }
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
