import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { handleError, requireUser } from "@/lib/http";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

interface Ctx {
  params: { path: string[] };
}

/**
 * Serve a stored PNG thumbnail from /data/thumbnails.
 * Any authenticated user may fetch thumbnails (they only contain a lightweight
 * preview; the full document enforces its own read permission).
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    requireUser(req);
    const cfg = config();
    const rel = (params.path || []).join("/");
    const safe = path.normalize(rel);
    const abs =
      safe.startsWith("thumbnails" + path.sep) || safe.startsWith("thumbnails/")
        ? path.join(cfg.dataDir, safe)
        : path.join(cfg.thumbnailsDir, safe);
    if (!abs.startsWith(cfg.thumbnailsDir) || path.extname(abs) !== ".png") {
      return new Response("Forbidden", { status: 403 });
    }
    if (!existsSync(abs)) {
      return new Response("Not found", { status: 404 });
    }
    const bytes = readFileSync(abs);
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