import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken, toPublicUser } from "@/lib/users";
import { getDocumentWithScene, getDocumentRaw, documentToMeta } from "@/lib/documents";
import { jsonToScene } from "@/lib/types";
import EditorClient from "./EditorClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
}

export default async function DocumentPage({ params }: PageProps) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const user = getUserBySessionToken(token);
  if (!user) redirect("/login");

  const { doc, scene, permission } = getDocumentWithScene(params.id, user.id, user.role, false);
  const meta = documentToMeta(getDocumentRaw(params.id)!, user.id, user.role, false);

  return (
    <EditorClient
      user={toPublicUser(user)}
      docId={params.id}
      initialTitle={meta.title}
      initialScene={scene}
      initialUpdatedAt={meta.updated_at}
      permission={meta.permission}
      deleted={!!doc.deleted_at}
    />
  );
}