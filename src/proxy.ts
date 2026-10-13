// Cloud mode gate: pages need a session cookie, API calls get 401. Local mode passes everything through.
// (The cookie is validated for real by currentUser() in each route; this only keeps anonymous traffic out.)
import { NextResponse, type NextRequest } from "next/server";

const OPEN = ["/login", "/api/auth/", "/_next/", "/favicon.ico"];
export function proxy(req: NextRequest) {
  if (process.env.ARKUS_MODE !== "cloud") return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(p))) return NextResponse.next();
  if (req.cookies.get("arkus_session")?.value) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login"; url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname + req.nextUrl.search)}` : "";
  return NextResponse.redirect(url);
}
export default proxy;
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
