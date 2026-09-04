import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken, toPublicUser } from "@/lib/users";
import { getDeck } from "@/lib/decks";
import DeckEditorClient from "./DeckEditorClient";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ id: string }> }

export default async function DeckPage({ params }: PageProps) {
  const { id } = await params;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const user = getUserBySessionToken(token);
  if (!user) redirect("/login");
  const deck = getDeck(id, user.id, user.role);
  return <DeckEditorClient initialDeck={deck} initialUser={toPublicUser(user)} />;
}
