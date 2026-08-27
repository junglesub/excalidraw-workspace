import { handleError, json, requireAdmin, requireUser } from "@/lib/http";
import { listAllDocuments } from "@/lib/documents";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const admin = requireUser(req);
    requireAdmin(admin);
    return json({ documents: listAllDocuments(admin.id) });
  } catch (err) {
    return handleError(err);
  }
}