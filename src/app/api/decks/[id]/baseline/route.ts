import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { getActiveRecordingBaseline, setRecordingBaseline } from "@/lib/presentation_snapshots";
import { assertActiveDeckEditLease, parseDeckLeaseCredentials } from "@/lib/deck_edit_lease";

interface Ctx { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    return json({ baseline: getActiveRecordingBaseline(id, user.id, user.role) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id } = await params;
    const body = await readJson(req);
    const deckLease = parseDeckLeaseCredentials(body.deckLease);
    if (!deckLease) return jsonError("Deck lease credentials are required", 400);
    assertActiveDeckEditLease({ deckId: id, userId: user.id, role: user.role, ...deckLease });
    return json({ baseline: setRecordingBaseline(id, user.id, user.role) }, 201);
  } catch (err) {
    return handleError(err);
  }
}
