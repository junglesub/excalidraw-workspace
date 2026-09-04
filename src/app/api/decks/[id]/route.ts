import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { deleteDeck, getDeck, renameDeck, setDeckAspectRatio } from "@/lib/decks";
import type { DeckAspectRatio } from "@/lib/types";

interface Ctx { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    return json({ deck: getDeck(id, user.id, user.role) });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    const body = await readJson(req);
    if (body.title === undefined && body.aspectRatio === undefined) {
      return jsonError("title or aspectRatio is required", 400);
    }
    if (body.title !== undefined) {
      if (typeof body.title !== "string") return jsonError("title must be a string", 400);
      renameDeck(id, body.title, user.id, user.role);
    }
    if (body.aspectRatio !== undefined) {
      if (typeof body.aspectRatio !== "string") return jsonError("aspectRatio must be a string", 400);
      setDeckAspectRatio(id, body.aspectRatio as DeckAspectRatio, user.id, user.role);
    }
    return json({ deck: getDeck(id, user.id, user.role) });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    deleteDeck(id, user.id, user.role);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
