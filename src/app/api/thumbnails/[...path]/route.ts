import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { handleError, requireUser } from "@/lib/http";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { requireRead } from "@/lib/documents";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ path: string[] }>;
}

/**
 * Serve a stored PNG thumbnail from /data/thumbnails.
 * Thumbnails require the same read permission as their owning document.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { path: pathSegments } = await params;
    const user = requireUser(req);
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
    const relativePath = path.relative(cfg.dataDir, resolvedAbs).split(path.sep).join("/");
    const owner = getDb().prepare(`
      SELECT id AS document_id FROM documents WHERE replace(thumbnail_path, char(92), '/') = ?
      UNION SELECT document_id FROM document_versions WHERE replace(thumbnail_path, char(92), '/') = ?
    `).get(relativePath, relativePath) as { document_id: string } | undefined;
    if (!owner) return new Response("Not found", { status: 404 });
    // Match attachment reads: administrators may inspect all document assets.
    requireRead(owner.document_id, user.id, user.role, user.role === "ADMIN");
    const bytes = readFileSync(resolvedAbs);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
