// GET → redirect to Google. State + PKCE verifier live in a short-lived httpOnly cookie.
import { NextResponse } from "next/server";
import { cookieOptions, googleAuthUrl, googleConfigured, isCloud, publicUrl, STATE_COOKIE } from "@/lib/auth";

export async function GET(req: Request) {
  if (!isCloud()) return NextResponse.redirect(`${publicUrl()}/`);
  if (!googleConfigured()) return NextResponse.json({ error: "Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)" }, { status: 500 });
  const next = new URL(req.url).searchParams.get("next") || "/";
  const { url, state, verifier } = googleAuthUrl();
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, JSON.stringify({ state, verifier, next: next.startsWith("/") ? next : "/" }), { ...cookieOptions(new Date(Date.now() + 10 * 60e3)) });
  return res;
}
