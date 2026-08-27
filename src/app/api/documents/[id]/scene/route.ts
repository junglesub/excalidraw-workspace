import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { updateScene, getDocumentRaw } from "@/lib/documents";
import { jsonToScene } from "@/lib/types";
import { createSnapshotFromScene, snapshotDueForAutoSave, AUTO_INTERVAL } from "@/lib/versions";
import { saveThumbnailFromBuffer } from "@/lib/thumbnails";

export const dynamic = "force-dynamic";

interface Ctx {
  params: { id: string };
}

/**
 * Auto-save endpoint (client debounces ~3s). Writes the current scene without
 * forcing a new recovery snapshot, but when the caller reports it has been >=5
 * minutes since the last snapshot AND enough time has elapsed server-side, a
 * snapshot is created per the snapshot policy.
 */
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    if (!body.scene || typeof body.scene !== "object") {
      return jsonError("scene is required", 400);
    }
    const scene = jsonToScene(JSON.stringify(body.scene));
    const doc = updateScene(params.id, scene, user.id, user.role, adminMode);

    let thumbBuf: Buffer | null = null;
    const thumbnailBase64 = typeof body.thumbnailBase64 === "string" ? body.thumbnailBase64 : null;
    if (thumbnailBase64 && thumbnailBase64.includes("base64,")) {
      const b64 = thumbnailBase64.split("base64,")[1];
      thumbBuf = Buffer.from(b64, "base64");
      saveThumbnailFromBuffer(params.id, thumbBuf);
    }

    let snapshotCreated = false;
    const wantSnapshot = body.snapshot === true;
    if (wantSnapshot && snapshotDueForAutoSave(params.id, AUTO_INTERVAL)) {
      createSnapshotFromScene(params.id, scene, user.id, true, thumbBuf);
      snapshotCreated = true;
    }
    return json({ ok: true, snapshotCreated, updatedAt: getDocumentRaw(params.id)!.updated_at });
  } catch (err) {
    return handleError(err);
  }
}