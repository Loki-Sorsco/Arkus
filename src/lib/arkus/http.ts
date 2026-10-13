// API client storage + sender. Environments (base URL, headers, auth) live encrypted in the Setting
// table per project+env; saved requests and history are plain JSON there. `sendRequest` runs server
// side (no CORS), follows at most 5 redirects, caps the body at 2 MB and refuses non-http(s) URLs.
import { prisma } from "../db";
import { decrypt, encrypt, isEncrypted } from "./secrets";

export type KV = { name: string; value: string; enabled: boolean };
export type HttpAuth = { type: "none" | "bearer" | "basic" | "apikey"; token?: string; username?: string; password?: string; headerName?: string };
export type HttpEnv = { baseUrl: string; headers: KV[]; auth: HttpAuth };
export type BodyMode = "none" | "json" | "text" | "form";
export type RequestBody = { mode: BodyMode; text?: string; form?: KV[] };
export type SavedRequest = { id: string; name: string; folder?: string; method: string; url: string; params: KV[]; headers: KV[]; body: RequestBody; auth?: "inherit" | HttpAuth; endpointKey?: string; createdAt: string; updatedAt: string };
export type HistoryEntry = { id: string; at: string; env: string; method: string; url: string; status: number; ms: number; size: number; savedId?: string };
export type SendResult = { ok: boolean; status: number; statusText: string; headers: Record<string, string>; body: string; size: number; ms: number; truncated: boolean; finalUrl: string; error?: string };

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export const MASK = "••••";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HISTORY_CAP = 100;
export const emptyEnv = (): HttpEnv => ({ baseUrl: "", headers: [], auth: { type: "none" } });

const envKey = (projectId: string, env: string) => `http.env.${projectId}.${env}`;
const savedKey = (projectId: string) => `http.saved.${projectId}`;
const historyKey = (projectId: string) => `http.history.${projectId}`;

async function readSetting(key: string): Promise<string | null> { const row = await prisma.setting.findUnique({ where: { key } }); return row?.value ?? null; }
async function writeSetting(key: string, value: string) { await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }); }
const parse = <T>(s: string | null, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };

const cleanKV = (rows: unknown): KV[] => Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object").map((r) => ({ name: String((r as KV).name ?? ""), value: String((r as KV).value ?? ""), enabled: (r as KV).enabled !== false })).filter((r) => r.name || r.value) : [];
const cleanAuth = (a: unknown): HttpAuth => {
  const o = (a && typeof a === "object" ? a : {}) as HttpAuth;
  const type = (["none", "bearer", "basic", "apikey"] as const).includes(o.type) ? o.type : "none";
  return { type, token: o.token ? String(o.token) : undefined, username: o.username ? String(o.username) : undefined, password: o.password ? String(o.password) : undefined, headerName: o.headerName ? String(o.headerName) : undefined };
};
const cleanEnv = (v: unknown): HttpEnv => { const o = (v && typeof v === "object" ? v : {}) as Partial<HttpEnv>; return { baseUrl: String(o.baseUrl ?? "").trim(), headers: cleanKV(o.headers), auth: cleanAuth(o.auth) }; };

/** Mask a secret for the browser: "••••" + last 4 chars (or just the mask when short). */
export const mask = (s?: string) => !s ? "" : s.length > 8 ? `${MASK}${s.slice(-4)}` : MASK;
const isMasked = (s?: string) => !!s && s.startsWith(MASK);
export function maskAuth(a: HttpAuth): HttpAuth & { hasToken: boolean } {
  return { type: a.type, token: mask(a.token), username: a.username, password: mask(a.password), headerName: a.headerName, hasToken: !!(a.token || a.password) };
}
/** Env as returned to the browser: secrets masked, plus hasToken. */
export function maskEnv(e: HttpEnv): Omit<HttpEnv, "auth"> & { auth: ReturnType<typeof maskAuth> } { return { ...e, auth: maskAuth(e.auth) }; }

// ---------- environments ----------
export async function getEnv(projectId: string, env: string): Promise<HttpEnv> {
  const raw = await readSetting(envKey(projectId, env));
  if (!raw) return emptyEnv();
  try { return cleanEnv(JSON.parse(isEncrypted(raw) ? decrypt(raw) : raw)); } catch { return emptyEnv(); }
}
/** Store an env. Masked token/password values (unchanged in the editor) keep the stored secret. */
export async function putEnv(projectId: string, env: string, value: unknown): Promise<HttpEnv> {
  const prev = await getEnv(projectId, env);
  const next = cleanEnv(value);
  if (isMasked(next.auth.token)) next.auth.token = prev.auth.token;
  if (isMasked(next.auth.password)) next.auth.password = prev.auth.password;
  await writeSetting(envKey(projectId, env), encrypt(JSON.stringify(next)));
  return next;
}

// ---------- saved requests ----------
export async function listSaved(projectId: string): Promise<SavedRequest[]> { return parse<SavedRequest[]>(await readSetting(savedKey(projectId)), []); }
export async function upsertSaved(projectId: string, input: Partial<SavedRequest>): Promise<SavedRequest> {
  const list = await listSaved(projectId);
  const now = new Date().toISOString();
  const id = typeof input.id === "string" && input.id ? input.id : crypto.randomUUID();
  const prev = list.find((r) => r.id === id);
  const method = String(input.method || prev?.method || "GET").toUpperCase();
  const body = input.body && typeof input.body === "object" ? { mode: (["none", "json", "text", "form"] as const).includes(input.body.mode) ? input.body.mode : "none", text: input.body.text ? String(input.body.text) : undefined, form: cleanKV(input.body.form) } : prev?.body || { mode: "none" as const };
  const auth = input.auth === undefined ? prev?.auth ?? "inherit" : input.auth === "inherit" ? "inherit" : cleanAuth(input.auth);
  const rec: SavedRequest = {
    id, name: String(input.name || prev?.name || `${method} ${input.url || prev?.url || ""}`).trim().slice(0, 120) || "Untitled", folder: String(input.folder ?? prev?.folder ?? "").trim() || undefined,
    method, url: String(input.url ?? prev?.url ?? ""), params: cleanKV(input.params ?? prev?.params), headers: cleanKV(input.headers ?? prev?.headers), body, auth,
    endpointKey: input.endpointKey ? String(input.endpointKey) : prev?.endpointKey, createdAt: prev?.createdAt || now, updatedAt: now,
  };
  const next = prev ? list.map((r) => (r.id === id ? rec : r)) : [...list, rec];
  await writeSetting(savedKey(projectId), JSON.stringify(next));
  return rec;
}
export async function deleteSaved(projectId: string, id: string): Promise<boolean> {
  const list = await listSaved(projectId);
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  await writeSetting(savedKey(projectId), JSON.stringify(next));
  return true;
}

// ---------- history ----------
export async function listHistory(projectId: string): Promise<HistoryEntry[]> { return parse<HistoryEntry[]>(await readSetting(historyKey(projectId)), []); }
export async function appendHistory(projectId: string, e: Omit<HistoryEntry, "id" | "at">): Promise<HistoryEntry> {
  const entry: HistoryEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), ...e };
  const list = [entry, ...(await listHistory(projectId))].slice(0, HISTORY_CAP);
  await writeSetting(historyKey(projectId), JSON.stringify(list));
  return entry;
}
export async function clearHistory(projectId: string) { await prisma.setting.deleteMany({ where: { key: historyKey(projectId) } }); }

// ---------- sending ----------
/** `{{baseUrl}}` → env base; relative URLs get the base prepended; anything else is used as-is. */
export function resolveUrl(url: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let u = url.trim().replace(/\{\{\s*baseUrl\s*\}\}/g, base);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = base + (u.startsWith("/") || !u ? u : `/${u}`);
  return u;
}
/** Headers an auth config adds (name → value). */
export function authHeaders(a: HttpAuth | undefined): Record<string, string> {
  if (!a || a.type === "none") return {};
  if (a.type === "bearer") return a.token ? { Authorization: `Bearer ${a.token}` } : {};
  if (a.type === "basic") return { Authorization: `Basic ${Buffer.from(`${a.username || ""}:${a.password || ""}`).toString("base64")}` };
  if (a.type === "apikey") return a.token ? { [a.headerName || "X-API-Key"]: a.token } : {};
  return {};
}
const SECRET_HEADER = /^(authorization|cookie|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;
export const maskHeaders = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SECRET_HEADER.test(k) ? mask(v) : v]));

export async function sendRequest({ method, url, headers, body, timeoutMs = 30_000 }: { method: string; url: string; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<SendResult> {
  const t0 = performance.now();
  const fail = (error: string): SendResult => ({ ok: false, status: 0, statusText: "", headers: {}, body: "", size: 0, ms: Math.round(performance.now() - t0), truncated: false, finalUrl: url, error });
  let target: URL;
  try { target = new URL(url); } catch { return fail(`Invalid URL: ${url || "(empty)"}`); }
  if (target.protocol !== "http:" && target.protocol !== "https:") return fail(`Only http(s) URLs can be sent (got ${target.protocol})`);
  const m = method.toUpperCase();
  const hasBody = body != null && body !== "" && m !== "GET" && m !== "HEAD";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res: Response | null = null;
    let cur = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(cur, { method: m, headers, body: hasBody ? body : undefined, redirect: "manual", signal: ac.signal });
      const loc = res.headers.get("location");
      if (!(res.status >= 300 && res.status < 400 && loc)) break;
      if (hop === MAX_REDIRECTS) return fail(`Too many redirects (more than ${MAX_REDIRECTS})`);
      cur = new URL(loc, cur);
      if (cur.protocol !== "http:" && cur.protocol !== "https:") return fail(`Redirected to a non-http URL: ${cur.protocol}`);
    }
    if (!res) return fail("No response");
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_BODY;
    const text = (truncated ? buf.subarray(0, MAX_BODY) : buf).toString("utf8");
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: h, body: text, size: buf.length, ms: Math.round(performance.now() - t0), truncated, finalUrl: cur.toString() };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "AbortError") return fail(`Timed out after ${timeoutMs / 1000}s`);
    return fail(`Request failed: ${err.cause?.code || err.cause?.message || err.message}`);
  } finally { clearTimeout(timer); }
}
