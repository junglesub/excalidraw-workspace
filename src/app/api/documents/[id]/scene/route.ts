import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { jsonToScene } from "@/lib/types";
import { handleAutoSave } from "@/lib/versions";
import { decodePngDataURL } from "@/lib/thumbnails";
import { parseAndValidateLeaseCredentials } from "@/lib/edit_lease";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Auto-save endpoint (client debounces ~3s). Writes the current scene without
 * forcing a new recovery snapshot, but when the caller reports it has been >=5
 * minutes since the last snapshot AND enough time has elapsed server-side, a
 * snapshot is created per the snapshot policy.
 */
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    if (!body.scene || typeof body.scene !== "object") {
      return jsonError("scene is required", 400);
    }
    const scene = jsonToScene(JSON.stringify(body.scene));
    const thumbBuf = decodePngDataURL(body.thumbnailBase64);
    const leaseCreds = parseAndValidateLeaseCredentials((body as Record<string, unknown>).lease as Record<string, unknown>);
    if (!leaseCreds) {
      return jsonError("lease credentials are required", 400);
    }
    const leaseAuthorization = body.leaseScope === "deck"
      ? (typeof body.deckId === "string" && body.deckId.trim()
        ? { scope: "deck" as const, deckId: body.deckId, credentials: leaseCreds }
        : null)
      : leaseCreds;
    if (!leaseAuthorization) {
      return jsonError("deckId is required for Deck-scoped saves", 400);
    }
    const wantSnapshot = body.snapshot === true;
    const result = handleAutoSave(id, user.id, user.role, adminMode, scene, thumbBuf, wantSnapshot, leaseAuthorization);
    return json({ ok: true, snapshotCreated: result.snapshotCreated, updatedAt: result.updatedAt });
  } catch (err) {
    return handleError(err);
  }
}