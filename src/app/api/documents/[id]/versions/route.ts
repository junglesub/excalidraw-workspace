import { handleError, json, requireUser, adminModeFrom } from "@/lib/http";
import { listVersions } from "@/lib/versions";
import { getDocumentRaw, requireRead } from "@/lib/documents";

interface Ctx {
  params: { id: string };
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    requireRead(params.id, user.id, user.role, adminMode);
    const doc = getDocumentRaw(params.id);
    if (!doc) return json({ error: "Document not found" }, 404);
    return json({ versions: listVersions(params.id) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  // Restore action dispatched via ?action=restore&versionId=...
  try {
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const url = new URL(req.url);
    const versionId = url.searchParams.get("versionId");
    if (url.searchParams.get("action") !== "restore" || !versionId) {
      return json({ error: "versionId is required" }, 400);
    }
    const { restoreVersion } = await import("@/lib/versions");
    const snapshot = restoreVersion(params.id, versionId, user.id, user.role, adminMode);
    return json({ ok: true, snapshot, versions: listVersions(params.id) });
  } catch (err) {
    return handleError(err);
  }
}