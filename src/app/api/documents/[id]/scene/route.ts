import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { jsonToScene } from "@/lib/types";
import { handleAutoSave } from "@/lib/versions";
import { decodePngDataURL } from "@/lib/thumbnails";

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
    const lease = (body as Record<string, unknown>).lease as unknown;
    if (!lease || typeof lease !== "object" || typeof (lease as Record<string, unknown>).clientId !== "string" || !(lease as Record<string, unknown>).clientId || String((lease as Record<string, unknown>).clientId).length > 256 || typeof (lease as Record<string, unknown>).leaseToken !== "string" || !(lease as Record<string, unknown>).leaseToken || String((lease as Record<string, unknown>).leaseToken).length > 256 || typeof (lease as Record<string, unknown>).generation !== "number" || !Number.isSafeInteger((lease as Record<string, unknown>).generation) || Number((lease as Record<string, unknown>).generation) <= 0) {
      return jsonError("lease credentials are required", 400);
    }
    const leaseCreds = lease as { clientId: string; leaseToken: string; generation: number };
    const wantSnapshot = body.snapshot === true;
    const result = handleAutoSave(id, user.id, user.role, adminMode, scene, thumbBuf, wantSnapshot, leaseCreds);
    return json({ ok: true, snapshotCreated: result.snapshotCreated, updatedAt: result.updatedAt });
  } catch (err) {
    return handleError(err);
  }
}