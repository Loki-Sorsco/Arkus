// Google sends the user back here: verify state, exchange the code, upsert the User, start a session.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { COOKIE, cookieOptions, createSession, googleExchange, isCloud, publicUrl, STATE_COOKIE } from "@/lib/auth";

export async function GET(req: Request) {
  const base = publicUrl();
  if (!isCloud()) return NextResponse.redirect(`${base}/`);
  const u = new URL(req.url);
  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  const raw = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${STATE_COOKIE}=`))?.slice(STATE_COOKIE.length + 1);
  let saved: { state: string; verifier: string; next: string; role?: string } | null = null;
  try { saved = raw ? JSON.parse(decodeURIComponent(raw)) : null; } catch { saved = null; }
  if (!code || !state || !saved || saved.state !== state) return NextResponse.redirect(`${base}/login?error=state`);
  try {
    const g = await googleExchange(code, saved.verifier);
    const role = saved.role === "viewer" ? "viewer" : "developer";
    const user = await prisma.user.upsert({ where: { email: g.email }, update: { name: g.name ?? undefined, image: g.picture ?? undefined, role }, create: { email: g.email, name: g.name ?? null, image: g.picture ?? null, role } });
    const s = await createSession(user.id, req.headers.get("user-agent"));
    const res = NextResponse.redirect(`${base}${saved.next || "/"}`);
    res.cookies.set(COOKIE, s.token, cookieOptions(s.expiresAt));
    res.cookies.set(STATE_COOKIE, "", { ...cookieOptions(new Date(0)) });
    return res;
  } catch (e) {
    console.error("[auth] google callback failed:", (e as Error).message);
    return NextResponse.redirect(`${base}/login?error=google`);
  }
}
