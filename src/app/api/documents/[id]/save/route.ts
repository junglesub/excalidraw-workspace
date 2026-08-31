import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { updateScene } from "@/lib/documents";
import { jsonToScene } from "@/lib/types";
import { createSnapshotFromScene, listVersions } from "@/lib/versions";
import { decodePngDataURL } from "@/lib/thumbnails";

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
    updateScene(id, scene, user.id, user.role, adminMode, { thumbnailBuffer: thumbBuf });

    const snapshot = createSnapshotFromScene(id, scene, user.id, true, thumbBuf, { origin: "manual_save" });
    const versions = listVersions(id);
    return json({ ok: true, snapshot, versions });
  } catch (err) {
    return handleError(err);
  }
}