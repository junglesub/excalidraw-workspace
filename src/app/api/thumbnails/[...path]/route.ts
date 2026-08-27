import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { handleError, requireUser } from "@/lib/http";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ path: string[] }>;
}

/**
 * Serve a stored PNG thumbnail from /data/thumbnails.
 * Any authenticated user may fetch thumbnails (they only contain a lightweight
 * preview; the full document enforces its own read permission).
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { path: pathSegments } = await params;
    requireUser(req);
    const cfg = config();
    const rel = (pathSegments || []).join("/");
    const safe = path.normalize(rel);
    const abs =
      safe.startsWith("thumbnails" + path.sep) || safe.startsWith("thumbnails/")
        ? path.join(cfg.dataDir, safe)
        : path.join(cfg.thumbnailsDir, safe);
    const resolvedAbs = path.resolve(abs);
    const resolvedThumbnailsDir = path.resolve(cfg.thumbnailsDir);

    if (!resolvedAbs.startsWith(resolvedThumbnailsDir + path.sep) || path.extname(resolvedAbs) !== ".png") {
      return new Response("Forbidden", { status: 403 });
    }
    if (!existsSync(resolvedAbs)) {
      return new Response("Not found", { status: 404 });
    }
    const bytes = readFileSync(resolvedAbs);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}