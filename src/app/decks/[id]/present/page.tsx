import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken } from "@/lib/users";
import { getDeck } from "@/lib/decks";
import PresentModeClient from "./PresentModeClient";

export const dynamic = "force-dynamic";

export default async function PresentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const user = getUserBySessionToken(token);
  if (!user) redirect("/login");
  const deck = getDeck(id, user.id, user.role);
  return <PresentModeClient initialDeck={deck} />;
}
