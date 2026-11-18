import { handleError, json, readJson, requireUser } from "@/lib/http";
import { createDeck, listDecks } from "@/lib/decks";
import { FolderError, parseDestinationFolderId } from "@/lib/folders";
import type { DeckAspectRatio } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    return json({ decks: listDecks(user.id) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const body = await readJson(req);
    const title = typeof body.title === "string" ? body.title : "Untitled Deck";
    const aspectRatio = (typeof body.aspectRatio === "string" ? body.aspectRatio : "16:9") as DeckAspectRatio;
    const folderId = parseDestinationFolderId(body.folderId, { required: false });
    const deck = createDeck(user.id, title, aspectRatio, folderId);
    return json({ deck }, 201);
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}
