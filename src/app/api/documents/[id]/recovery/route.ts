import { adminModeFrom, handleError, json, jsonError, readJson, requireUser } from "@/lib/http";
import { decodePngDataURL } from "@/lib/thumbnails";
import type { ExcalidrawScene } from "@/lib/types";
import { resolveRecoveryConflict } from "@/lib/versions";

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

    const lease = (body as Record<string, unknown>).lease as unknown;
    if (!lease || typeof lease !== "object" || typeof (lease as Record<string, unknown>).clientId !== "string" || !(lease as Record<string, unknown>).clientId || String((lease as Record<string, unknown>).clientId).length > 256 || typeof (lease as Record<string, unknown>).leaseToken !== "string" || !(lease as Record<string, unknown>).leaseToken || String((lease as Record<string, unknown>).leaseToken).length > 256 || typeof (lease as Record<string, unknown>).generation !== "number" || !Number.isSafeInteger((lease as Record<string, unknown>).generation) || Number((lease as Record<string, unknown>).generation) <= 0) {
      return jsonError("lease credentials are required", 400);
    }
    const leaseCreds = lease as { clientId: string; leaseToken: string; generation: number };
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
