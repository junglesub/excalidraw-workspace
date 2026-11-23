import { handleError, json, readJson, requireUser } from "@/lib/http";
import {
  createFolder,
  FolderError,
  getFolderBreadcrumbs,
  listAllUserFolders,
  listFolders,
  parseDestinationFolderId,
} from "@/lib/folders";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    const url = new URL(req.url);
    const all = url.searchParams.get("all") === "1";
    const parentIdParam = url.searchParams.get("parentId");
    const parentId = parentIdParam && parentIdParam.length > 0 ? parentIdParam : null;

    if (all) {
      return json({
        folders: listAllUserFolders(user.id),
        breadcrumbs: parentId ? getFolderBreadcrumbs(user.id, parentId) : [],
      });
    }

    return json({
      folders: listFolders(user.id, parentId),
      breadcrumbs: parentId ? getFolderBreadcrumbs(user.id, parentId) : [],
    });
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = requireUser(req);
    const body = await readJson(req);
    const parentId = parseDestinationFolderId(body.parentId, { required: false });
    const folder = createFolder(user.id, body.name, parentId);
    return json({ folder }, 201);
  } catch (err) {
    if (err instanceof FolderError) return json({ error: err.message }, err.status);
    return handleError(err);
  }
}
