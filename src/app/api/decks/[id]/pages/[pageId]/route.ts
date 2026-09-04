import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { deletePage, getDeck, renamePage } from "@/lib/decks";

interface Ctx { params: Promise<{ id: string; pageId: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id, pageId } = await params;
    const body = await readJson(req);
    if (typeof body.title !== "string") return jsonError("title is required", 400);
    const page = renamePage(id, pageId, body.title, user.id, user.role);
    return json({ deck: getDeck(id, user.id, user.role), page });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id, pageId } = await params;
    return json({ deck: deletePage(id, pageId, user.id, user.role) });
  } catch (err) {
    return handleError(err);
  }
}
