import { handleError, json, requireUser } from "@/lib/http";
import { listSharedDocuments } from "@/lib/documents";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    return json({ documents: listSharedDocuments(user.id) });
  } catch (err) {
    return handleError(err);
  }
}