import { adminModeFrom, handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { decodePngDataURL } from "@/lib/thumbnails";
import type { ExcalidrawScene } from "@/lib/types";
import { resolveRecoveryConflict } from "@/lib/versions";
import { parseAndValidateLeaseCredentials } from "@/lib/edit_lease";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    if (body.choice !== "client" && body.choice !== "server") {
      return jsonError("choice must be client or server", 400);
    }
    if (
      typeof body.preserveDiscarded !== "boolean" ||
      typeof body.expectedServerUpdatedAt !== "string" ||
      typeof body.clientUpdatedAt !== "number" ||
      !Number.isFinite(body.clientUpdatedAt) ||
      !body.clientScene ||
      typeof body.clientScene !== "object" ||
      !Array.isArray((body.clientScene as { elements?: unknown }).elements)
    ) {
      return jsonError("invalid recovery request", 400);
    }

    const leaseCreds = parseAndValidateLeaseCredentials((body as Record<string, unknown>).lease as Record<string, unknown>);
    if (!leaseCreds) {
      return jsonError("lease credentials are required", 400);
    }
    const result = resolveRecoveryConflict(
      id,
      user.id,
      user.role,
      adminMode,
      {
        choice: body.choice,
        preserveDiscarded: body.preserveDiscarded,
        expectedServerUpdatedAt: body.expectedServerUpdatedAt,
        clientScene: body.clientScene as ExcalidrawScene,
        thumbnailBuffer: decodePngDataURL(body.clientThumbnailBase64),
      },
      leaseCreds,
    );
    return json(result, result.ok ? 200 : 409);
  } catch (error) {
    return handleError(error);
  }
}
