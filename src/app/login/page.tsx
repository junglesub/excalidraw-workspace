import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/http";
import { getUserBySessionToken } from "@/lib/users";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const user = getUserBySessionToken(token);
    if (user && user.is_active === 1) {
      redirect("/dashboard");
    }
  }

  return <LoginForm />;
}