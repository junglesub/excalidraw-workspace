import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken, toPublicUser } from "@/lib/users";
import { getDocumentWithScene, getDocumentRaw, documentToMeta } from "@/lib/documents";
import EditorClient from "./EditorClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ adminMode?: string }>;
}

export default async function DocumentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const adminMode = sp?.adminMode === "1";
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const user = getUserBySessionToken(token);
  if (!user) redirect("/login");

  const effectiveAdminMode = adminMode && user.role === "ADMIN";
  const { doc, scene } = getDocumentWithScene(id, user.id, user.role, effectiveAdminMode, { hydrate: false });
  const meta = documentToMeta(getDocumentRaw(id)!, user.id, user.role, effectiveAdminMode);

  return (
    <EditorClient
      user={toPublicUser(user)}
      docId={id}
      initialTitle={meta.title}
      initialScene={scene}
      initialUpdatedAt={meta.updated_at}
      permission={meta.permission}
      deleted={!!doc.deleted_at}
      adminMode={effectiveAdminMode}
    />
  );
}