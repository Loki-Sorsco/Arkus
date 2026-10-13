// Who is using Arkus. Local mode (npx arkus): one implicit owner "local", no login. Cloud mode
// (ARKUS_MODE=cloud): Google sign-in, a Session row per browser, httpOnly cookie, every project owned
// by a User. Nothing here touches the user's own databases; this is Arkus's metadata only.
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";

export const COOKIE = "arkus_session";
export const STATE_COOKIE = "arkus_oauth";
const SESSION_DAYS = 30;
export type Me = { id: string; email: string | null; name: string | null; image: string | null };
export const LOCAL_USER: Me = { id: "local", email: null, name: "You", image: null };

export const isCloud = () => process.env.ARKUS_MODE === "cloud";
export const publicUrl = () => (process.env.ARKUS_URL || "http://localhost:3600").replace(/\/+$/, "");

/** Current user, or null when cloud mode has no valid session. Local mode always returns LOCAL_USER. */
export async function currentUser(): Promise<Me | null> {
  if (!isCloud()) return LOCAL_USER;
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!s || s.expiresAt < new Date()) return null;
  return { id: s.user.id, email: s.user.email, name: s.user.name, image: s.user.image };
}
export async function requireUser(): Promise<Me> {
  const u = await currentUser();
  if (!u) throw new AuthError();
  return u;
}
export class AuthError extends Error { status = 401; constructor() { super("Sign in required"); } }

/** Setting keys are global in local mode and per-user in cloud mode. */
export async function userKey(key: string): Promise<string> {
  if (!isCloud()) return key;
  const u = await currentUser();
  return `u:${u?.id ?? "anon"}:${key}`;
}

export async function createSession(userId: string, userAgent?: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400e3);
  await prisma.session.create({ data: { token, userId, expiresAt, userAgent: userAgent?.slice(0, 200) || null } });
  return { token, expiresAt };
}
export async function destroySession(token: string) { await prisma.session.deleteMany({ where: { token } }); }
export const cookieOptions = (expires: Date) => ({ httpOnly: true, sameSite: "lax" as const, secure: publicUrl().startsWith("https://"), path: "/", expires });

// ---------- Google OAuth (authorization code + PKCE) ----------
export function googleConfigured() { return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
export const googleRedirectUri = () => `${publicUrl()}/api/auth/google/callback`;
export function googleAuthUrl(): { url: string; state: string; verifier: string } {
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || "", redirect_uri: googleRedirectUri(), response_type: "code", scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", access_type: "online", prompt: "select_account" });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state, verifier };
}
export async function googleExchange(code: string, verifier: string): Promise<{ email: string; name?: string; picture?: string }> {
  const body = new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "", redirect_uri: googleRedirectUri(), grant_type: "authorization_code", code_verifier: verifier });
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
  if (!tok.ok) throw new Error(`Google token exchange failed (${tok.status})`);
  const { access_token } = (await tok.json()) as { access_token?: string };
  if (!access_token) throw new Error("Google returned no access token");
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(15000) });
  if (!info.ok) throw new Error(`Google userinfo failed (${info.status})`);
  const u = (await info.json()) as { email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!u.email || u.email_verified === false) throw new Error("Google account has no verified email");
  return { email: u.email.toLowerCase(), name: u.name, picture: u.picture };
}
