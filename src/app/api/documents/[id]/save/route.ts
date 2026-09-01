import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { jsonToScene } from "@/lib/types";
import { handleManualSave } from "@/lib/versions";
import { decodePngDataURL } from "@/lib/thumbnails";
import { parseAndValidateLeaseCredentials } from "@/lib/edit_lease";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Manual save: instantly persists the scene and always creates a recovery
 * snapshot (thumbnail refreshed on server).
 */
export async function POST(req: Request, { params }: Ctx) {
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
    const result = handleManualSave(id, user.id, user.role, adminMode, scene, thumbBuf, leaseCreds);
    return json({
      ok: true,
      alreadySaved: result.alreadySaved,
      snapshotCreated: result.snapshotCreated,
      snapshot: result.snapshot,
      versions: result.versions,
    });
  } catch (err) {
    return handleError(err);
  }
}