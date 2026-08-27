import { handleError, json, jsonError, readJson, requireUser, adminModeFrom } from "@/lib/http";
import { updateScene } from "@/lib/documents";
import { jsonToScene } from "@/lib/types";
import { createSnapshotFromScene, listVersions } from "@/lib/versions";
import { saveThumbnailFromBuffer } from "@/lib/thumbnails";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Manual save: instantly persists the scene and always creates a recovery
 * snapshot (thumbnail refreshed).
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
    updateScene(id, scene, user.id, user.role, adminMode);

    let thumbBuf: Buffer | null = null;
    const thumbnailBase64 = typeof body.thumbnailBase64 === "string" ? body.thumbnailBase64 : null;
    if (thumbnailBase64 && thumbnailBase64.includes("base64,")) {
      const b64 = thumbnailBase64.split("base64,")[1];
      thumbBuf = Buffer.from(b64, "base64");
      saveThumbnailFromBuffer(id, thumbBuf);
    }

    const snapshot = createSnapshotFromScene(id, scene, user.id, true, thumbBuf);
    const versions = listVersions(id);
    return json({ ok: true, snapshot, versions });
  } catch (err) {
    return handleError(err);
  }
}