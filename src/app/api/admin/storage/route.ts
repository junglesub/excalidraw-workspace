import { handleError, json, jsonError, readJson, requireAdmin, requireUser } from "@/lib/http";
import { scanStorage, cleanOrphans, runVacuum } from "@/lib/storage_maintenance";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/storage
 * Admin-only: Full read-only storage scan and metrics.
 */
export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    requireAdmin(user);
    const report = scanStorage();
    return json(report);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * POST /api/admin/storage
 * Admin-only: Explicitly confirmed storage maintenance actions (cleanup, vacuum).
 */
export async function POST(req: Request) {
  try {
    const admin = requireUser(req);
    requireAdmin(admin);
    const body = await readJson(req);
    const action = String(body.action || "").trim().toLowerCase();
    const confirm = body.confirm === true;

    if (action === "cleanup") {
      if (!confirm) {
        return jsonError("Explicit confirmation required for storage cleanup", 400);
      }
      const result = cleanOrphans(confirm);
      return json(result);
    }

    if (action === "vacuum") {
      if (!confirm) {
        return jsonError("Explicit confirmation required for SQLite VACUUM", 400);
      }
      const result = runVacuum(confirm);
      return json(result);
    }

    return jsonError("Invalid action. Supported actions: 'cleanup', 'vacuum'", 400);
  } catch (err) {
    return handleError(err);
  }
}
