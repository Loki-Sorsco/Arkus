// POST /api/projects/:id/http/send { env, request: { method, url, params, headers, body, auth }, savedId? }
// Merges the env's headers + auth with the request, sends from the server (no CORS), appends history and
// logs an Activity. Secrets are masked in everything returned; auth headers are never logged.
import { prisma } from "@/lib/db";
import { bad, ok, readJson } from "@/app/api/_util";
import { resolveProject } from "@/lib/arkus/project";
import { appendHistory, authHeaders, getEnv, maskHeaders, METHODS, resolveUrl, sendRequest, type HttpAuth, type KV, type RequestBody } from "@/lib/arkus/http";

type Body = { env?: string; savedId?: string; request?: { method?: string; url?: string; params?: KV[]; headers?: KV[]; body?: RequestBody; auth?: "inherit" | HttpAuth } };
const on = (rows?: KV[]) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.enabled !== false && r.name);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  const body = await readJson<Body>(req);
  const env = typeof body.env === "string" && body.env ? body.env : "dev";
  const r = body.request;
  if (!r || typeof r !== "object") return bad("request is required");
  const method = String(r.method || "GET").toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) return bad(`unsupported method ${method}`);
  const e = await getEnv(p.id, env);

  // URL: substitute base, then append enabled params.
  let url = resolveUrl(String(r.url || ""), e.baseUrl);
  const qs = on(r.params).map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value ?? "")}`).join("&");
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;

  // Headers: env headers < auth < request headers (request wins).
  const headers: Record<string, string> = {};
  for (const h of on(e.headers)) headers[h.name] = h.value;
  Object.assign(headers, authHeaders(r.auth === undefined || r.auth === "inherit" ? e.auth : r.auth));
  let text: string | undefined;
  const b = r.body;
  if (b && b.mode !== "none" && method !== "GET" && method !== "HEAD") {
    if (b.mode === "json") { text = b.text || ""; headers["Content-Type"] = headers["Content-Type"] || "application/json"; }
    else if (b.mode === "text") { text = b.text || ""; headers["Content-Type"] = headers["Content-Type"] || "text/plain"; }
    else if (b.mode === "form") { text = new URLSearchParams(on(b.form).map((f) => [f.name, f.value ?? ""])).toString(); headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded"; }
  }
  for (const h of on(r.headers)) headers[h.name] = h.value;

  const res = await sendRequest({ method, url, headers, body: text });
  const what = `${method} ${url} → ${res.status || "failed"}`.slice(0, 200);
  await Promise.all([
    appendHistory(p.id, { env, method, url, status: res.status, ms: res.ms, size: res.size, savedId: body.savedId || undefined }),
    prisma.activity.create({ data: { projectId: p.id, env, kind: "request", what, meta: JSON.stringify({ method, url, status: res.status, ms: res.ms, size: res.size, error: res.error }) } }),
  ]);
  return ok({ ...res, request: { url, headers: maskHeaders(headers) } });
}
