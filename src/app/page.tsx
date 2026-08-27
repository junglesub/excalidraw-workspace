import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function Home() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    const user = getUserBySessionToken(token);
    if (user && user.is_active === 1) {
      redirect("/dashboard");
    }
  }
  redirect("/login");
}