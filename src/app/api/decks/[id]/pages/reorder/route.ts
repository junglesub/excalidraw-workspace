import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { reorderPages } from "@/lib/decks";

interface Ctx { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    const body = await readJson(req);
    if (!Array.isArray(body.pageIds) || !body.pageIds.every((value) => typeof value === "string")) {
      return jsonError("pageIds must be a string array", 400);
    }
    return json({ deck: reorderPages(id, body.pageIds as string[], user.id, user.role) });
  } catch (err) {
    return handleError(err);
  }
}
