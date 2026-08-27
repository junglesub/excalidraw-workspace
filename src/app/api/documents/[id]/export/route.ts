import { handleError, requireUser, adminModeFrom } from "@/lib/http";
import { getDocumentWithScene } from "@/lib/documents";
import { exportSceneAsExcalidrawJson } from "@/lib/exc_io";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const { doc, scene } = getDocumentWithScene(id, user.id, user.role, adminMode);
    const content = exportSceneAsExcalidrawJson(scene);
    const filename = `${(doc.title || "document").replace(/[^\w.\- ]+/g, "_")}.excalidraw`;
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.excalidraw+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}