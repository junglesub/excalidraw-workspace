import { cookies } from "next/headers";
import { SESSION_COOKIE, findSessionToken } from "@/lib/http";
import { deleteSession } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = findSessionToken(req);
  if (token) {
    deleteSession(token);
  }
  cookies().set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}