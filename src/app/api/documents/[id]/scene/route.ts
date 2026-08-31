import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { updateScene, getDocumentRaw } from "@/lib/documents";
import { jsonToScene } from "@/lib/types";
import { createSnapshotFromScene, snapshotDueForAutoSave, AUTO_INTERVAL } from "@/lib/versions";
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
    updateScene(id, scene, user.id, user.role, adminMode, { thumbnailBuffer: thumbBuf });

    let snapshotCreated = false;
    const wantSnapshot = body.snapshot === true;
    if (wantSnapshot && snapshotDueForAutoSave(id, AUTO_INTERVAL)) {
      createSnapshotFromScene(id, scene, user.id, true, thumbBuf, { origin: "auto_snapshot" });
      snapshotCreated = true;
    }
    return json({ ok: true, snapshotCreated, updatedAt: getDocumentRaw(id)!.updated_at });
  } catch (err) {
    return handleError(err);
  }
}