import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken, toPublicUser } from "@/lib/users";
import DashBoardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const user = getUserBySessionToken(token);
  if (!user) redirect("/login");
  return <DashBoardClient initialUser={toPublicUser(user)} />;
}