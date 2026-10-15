// Development sign-in: POST { email } → session. Only when ARKUS_DEV_LOGIN=true (never set this in
// production); lets you try hosted mode before Google OAuth is configured.
import { NextResponse } from "next/server";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { asRole, COOKIE, cookieOptions, createSession, isCloud } from "@/lib/auth";
import { bad, readJson } from "../../_util";

const devLoginEnabled = () => isCloud() && process.env.ARKUS_DEV_LOGIN === "true";

export async function POST(req: Request) {
  if (limitsOn() && limited(`sign-in:${clientIp(req)}`, 20, 600000)) return tooMany("sign-in requests");
  if (!devLoginEnabled()) return bad("Not available", 404);
  const body = await readJson<{ email?: string; name?: string; role?: string }>(req);
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("Enter an email address");
  const role = asRole(body.role);
  const user = await prisma.user.upsert({ where: { email }, update: { role }, create: { email, name: body.name?.trim() || email.split("@")[0], role } });
  const s = await createSession(user.id, req.headers.get("user-agent"));
  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  res.cookies.set(COOKIE, s.token, cookieOptions(s.expiresAt));
  return res;
}
