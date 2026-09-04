import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { createBlankPage, duplicatePage, getDeck } from "@/lib/decks";

interface Ctx { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    const body = await readJson(req);
    let page;
    if (body.action === "blank") {
      page = createBlankPage(id, user.id, user.role);
    } else if (body.action === "duplicate") {
      if (typeof body.pageId !== "string" || !body.pageId) return jsonError("pageId is required", 400);
      page = duplicatePage(id, body.pageId, user.id, user.role);
    } else {
      return jsonError("Unsupported page action", 400);
    }
    return json({ deck: getDeck(id, user.id, user.role), page }, 201);
  } catch (err) {
    return handleError(err);
  }
}
