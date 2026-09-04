import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { resetRecordingBaseline } from "@/lib/presentation_snapshots";
import { assertActiveDeckEditLease, parseDeckLeaseCredentials } from "@/lib/deck_edit_lease";

interface Ctx { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    const body = await readJson(req);
    const deckLease = parseDeckLeaseCredentials(body.deckLease);
    if (!deckLease) return jsonError("Deck lease credentials are required", 400);
    assertActiveDeckEditLease({ deckId: id, userId: user.id, role: user.role, ...deckLease });
    if (body.scope === "all") {
      return json({ result: resetRecordingBaseline(id, { scope: "all" }, user.id, user.role) });
    }
    if (body.scope === "current" && typeof body.pageId === "string" && body.pageId) {
      return json({ result: resetRecordingBaseline(id, { scope: "current", pageId: body.pageId }, user.id, user.role) });
    }
    return jsonError("scope must be all or current with pageId", 400);
  } catch (err) {
    return handleError(err);
  }
}
