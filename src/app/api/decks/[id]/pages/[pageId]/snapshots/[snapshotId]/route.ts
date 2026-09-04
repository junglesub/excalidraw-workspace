import { handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { deleteNamedSnapshot } from "@/lib/presentation_snapshots";
import { assertActiveDeckEditLease, parseDeckLeaseCredentials } from "@/lib/deck_edit_lease";

interface Ctx { params: Promise<{ id: string; pageId: string; snapshotId: string }> }

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const { id, pageId, snapshotId } = await params;
    const body = await readJson(req);
    const deckLease = parseDeckLeaseCredentials(body.deckLease);
    if (!deckLease) return jsonError("Deck lease credentials are required", 400);
    assertActiveDeckEditLease({ deckId: id, userId: user.id, role: user.role, ...deckLease });
    deleteNamedSnapshot(id, pageId, snapshotId, user.id, user.role);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
