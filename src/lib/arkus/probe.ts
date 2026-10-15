// Live API monitor: Arkus sends GET/HEAD requests to the user's running app (same base URL and auth as
// the Test tab), records status + latency per endpoint in the Probe table and summarises the window.
// Never stores response bodies. Never sends anything but GET/HEAD unless keys are given explicitly.
import { prisma } from "../db";
import type { Graph } from "./types";
import { authHeaders, getEnv, resolveUrl, sendRequest } from "./http";

export type ProbeRow = { id: string; endpointKey: string; method: string; url: string; status: number; ms: number; ok: boolean; error: string | null; at: Date };
export type ProbeState = "ok" | "slow" | "failing" | "unreachable";
export interface EndpointSummary {
  key: string; method: string; path: string;
  state: ProbeState;
  lastStatus: number; lastMs: number; lastAt: string; lastError: string | null; lastUrl: string;
  p50: number; p95: number; failures: number; total: number; uptime: number;
  trend: number[]; // last 30 ms values, oldest first (0 for failed probes)
}
export type SeriesPoint = { at: string; ms: number; status: number; ok: boolean; error?: string | null };
export interface ProbeTotals { checked: number; ok: number; failing: number; unreachable: number; p50: number; p95: number; uptime: number; runs: number; lastAt: string | null }

const MAX_PER_ENV = 2000;
const SLOW_MS = 1500;
const TREND = 30;

/** 2xx/3xx, or 401/403: an auth-guarded endpoint that answers still proves the API is up. */
export const isOkStatus = (s: number) => (s >= 200 && s < 400) || s === 401 || s === 403;
/** `:id`, `[id]`, `{id}` and `*` segments become `1` so the URL is sendable. */
export const fillPath = (p: string) => p.replace(/:[A-Za-z_][\w]*\??/g, "1").replace(/\[\.{3}[^\]]*\]|\[[^\]]+\]/g, "1").replace(/\{[^}]+\}/g, "1").replace(/\*+/g, "1");

const epAttrs = (n: Graph["nodes"][number]) => ({ method: String(n.attrs?.method || "GET").toUpperCase(), path: String(n.attrs?.path || n.name || "/") });

export function pickEndpoints(graph: Graph, keys?: string[]) {
  const eps = graph.nodes.filter((n) => n.type === "endpoint");
  if (keys?.length) { const want = new Set(keys); return eps.filter((n) => want.has(n.key)); }
  return eps.filter((n) => { const m = epAttrs(n).method; return m === "GET" || m === "HEAD"; });
}

export async function runProbes({ projectId, env, graph, baseUrl, keys, concurrency = 4, timeoutMs = 8000 }: { projectId: string; env: string; graph: Graph; baseUrl?: string; keys?: string[]; concurrency?: number; timeoutMs?: number }): Promise<{ baseUrl: string; rows: ProbeRow[] }> {
  const cfg = await getEnv(projectId, env);
  const base = (baseUrl || cfg.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("No base URL for this environment. Tell Arkus where your app runs first.");
  const headers: Record<string, string> = { Accept: "application/json, text/html;q=0.8, */*;q=0.5", "User-Agent": "Arkus-LiveAPI/1" };
  for (const h of cfg.headers) if (h.enabled && h.name) headers[h.name] = h.value;
  Object.assign(headers, authHeaders(cfg.auth));
  const targets = pickEndpoints(graph, keys);
  const at = new Date();
  const results: Omit<ProbeRow, "id">[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const n = targets[i];
      const { method, path } = epAttrs(n);
      const m = method === "HEAD" ? "HEAD" : "GET";
      const url = resolveUrl(fillPath(path), base);
      const r = await sendRequest({ method: m, url, headers, timeoutMs });
      const ok = r.status > 0 && isOkStatus(r.status);
      const excerpt = !ok && r.status > 0 ? r.body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
      results[i] = { endpointKey: n.key, method, url, status: r.status, ms: r.ms, ok, error: r.error ? r.error.slice(0, 300) : excerpt ? `Response: ${excerpt}` : null, at };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length || 1)) }, worker));
  if (!results.length) return { baseUrl: base, rows: [] };
  await prisma.probe.createMany({ data: results.map((r) => ({ projectId, env, ...r })) });
  await trim(projectId, env);
  const rows = await prisma.probe.findMany({ where: { projectId, env, at }, orderBy: { endpointKey: "asc" } });
  return { baseUrl: base, rows: rows.map(toRow) };
}

const toRow = (r: { id: string; endpointKey: string; method: string; url: string; status: number; ms: number; ok: boolean; error: string | null; at: Date }): ProbeRow => ({ id: r.id, endpointKey: r.endpointKey, method: r.method, url: r.url, status: r.status, ms: r.ms, ok: r.ok, error: r.error, at: r.at });

/** Keep at most MAX_PER_ENV probes per project+env (delete the oldest). */
async function trim(projectId: string, env: string) {
  const n = await prisma.probe.count({ where: { projectId, env } });
  if (n <= MAX_PER_ENV) return;
  const old = await prisma.probe.findMany({ where: { projectId, env }, orderBy: { at: "asc" }, take: n - MAX_PER_ENV, select: { id: true } });
  await prisma.probe.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

export async function loadProbes(projectId: string, env: string, windowMs: number): Promise<ProbeRow[]> {
  const since = new Date(Date.now() - windowMs);
  const rows = await prisma.probe.findMany({ where: { projectId, env, at: { gte: since } }, orderBy: { at: "asc" } });
  return rows.map(toRow);
}

export async function clearProbes(projectId: string, env: string) { await prisma.probe.deleteMany({ where: { projectId, env } }); }

export const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : 0;

/** Per-endpoint summary over the rows (oldest first). Endpoint names come from the graph when given. */
export function summarize(rows: ProbeRow[], graph?: Graph): EndpointSummary[] {
  const byKey = new Map<string, ProbeRow[]>();
  for (const r of rows) { const l = byKey.get(r.endpointKey); if (l) l.push(r); else byKey.set(r.endpointKey, [r]); }
  const nodes = new Map((graph?.nodes || []).filter((n) => n.type === "endpoint").map((n) => [n.key, n]));
  const out: EndpointSummary[] = [];
  for (const [key, list] of byKey) {
    const last = list[list.length - 1];
    const okMs = list.filter((r) => r.status > 0).map((r) => r.ms).sort((a, b) => a - b);
    const failures = list.filter((r) => !r.ok).length;
    const p95 = percentile(okMs, 95);
    const state: ProbeState = last.status === 0 ? "unreachable" : !last.ok ? "failing" : p95 > SLOW_MS ? "slow" : "ok";
    const node = nodes.get(key);
    const { method, path } = node ? epAttrs(node) : { method: last.method, path: key.replace(/^endpoint:[A-Z]+ /, "") };
    out.push({ key, method, path, state, lastStatus: last.status, lastMs: last.ms, lastAt: last.at.toISOString(), lastError: last.error, lastUrl: last.url, p50: percentile(okMs, 50), p95, failures, total: list.length, uptime: Math.round(((list.length - failures) / list.length) * 100), trend: list.slice(-TREND).map((r) => (r.status > 0 ? r.ms : 0)) });
  }
  const rank: Record<ProbeState, number> = { unreachable: 0, failing: 1, slow: 2, ok: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.p95 - a.p95 || a.path.localeCompare(b.path));
}

/** Last `limit` points per endpoint, for the line chart. */
export function series(rows: ProbeRow[], limit = 60): Record<string, SeriesPoint[]> {
  const out: Record<string, SeriesPoint[]> = {};
  for (const r of rows) (out[r.endpointKey] ||= []).push({ at: r.at.toISOString(), ms: r.ms, status: r.status, ok: r.ok, error: r.error });
  for (const k of Object.keys(out)) if (out[k].length > limit) out[k] = out[k].slice(-limit);
  return out;
}

/** A check run from the browser arrives in batches a few seconds apart: rows closer than RUN_GAP form one run. */
const RUN_GAP = 20_000;
function groupRuns(rows: ProbeRow[]): ProbeRow[][] {
  const runs: ProbeRow[][] = [];
  let prev = -Infinity;
  for (const r of rows) { const t = r.at.getTime(); if (t - prev > RUN_GAP) runs.push([]); runs[runs.length - 1].push(r); prev = t; }
  return runs;
}

export function totals(rows: ProbeRow[], eps: EndpointSummary[]): ProbeTotals {
  const okMs = rows.filter((r) => r.status > 0).map((r) => r.ms).sort((a, b) => a - b);
  const runs = groupRuns(rows);
  const last = rows.length ? rows[rows.length - 1].at.toISOString() : null;
  return {
    checked: eps.length, ok: eps.filter((e) => e.state === "ok" || e.state === "slow").length,
    failing: eps.filter((e) => e.state === "failing").length, unreachable: eps.filter((e) => e.state === "unreachable").length,
    p50: percentile(okMs, 50), p95: percentile(okMs, 95),
    uptime: rows.length ? Math.round((rows.filter((r) => r.ok).length / rows.length) * 100) : 0,
    runs: runs.length, lastAt: last,
  };
}

/** Per-run uptime % (oldest first), for the Uptime stat tile sparkline. */
export function runUptimes(rows: ProbeRow[], limit = 30): number[] {
  return groupRuns(rows).slice(-limit).map((run) => Math.round((run.filter((r) => r.ok).length / run.length) * 100));
}
