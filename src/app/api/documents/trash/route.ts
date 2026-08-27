import { handleError, json, requireUser } from "@/lib/http";
import { listTrashDocuments } from "@/lib/documents";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    const isAdmin = user.role === "ADMIN";
    return json({ documents: listTrashDocuments(user.id, isAdmin) });
  } catch (err) {
    return handleError(err);
  }
}