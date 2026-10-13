import { NextResponse } from "next/server";
import { COOKIE, cookieOptions, destroySession } from "@/lib/auth";

export async function POST(req: Request) {
  const token = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (token) await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { ...cookieOptions(new Date(0)) });
  return res;
}
