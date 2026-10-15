// Live API monitor.
// GET    /api/projects/[id]/probe?env=dev&window=24h|7d → { baseUrl, window, endpoints, series, totals, uptimes, candidates }
// POST   /api/projects/[id]/probe { env, baseUrl?, keys? }  → runs probes now (developer only), returns the same shape
// DELETE /api/projects/[id]/probe?env=dev                   → clears recorded probes for that env
import { bad, ok, readJson } from "@/app/api/_util";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { loadGraph } from "@/lib/arkus/graph";
import { getEnv } from "@/lib/arkus/http";
import { clearProbes, loadProbes, pickEndpoints, runProbes, runUptimes, series, summarize, totals } from "@/lib/arkus/probe";
import { resolveProject } from "@/lib/arkus/project";

type Ctx = { params: Promise<{ id: string }> };
const ENVS = ["dev", "preview", "prod"];
const WINDOWS: Record<string, number> = { "24h": 24 * 3600e3, "7d": 7 * 86400e3 };

async function payload(projectId: string, env: string, win: string, baseUrl?: string) {
  const [graph, rows, cfg] = await Promise.all([loadGraph(projectId), loadProbes(projectId, env, WINDOWS[win]), getEnv(projectId, env)]);
  const endpoints = summarize(rows, graph);
  return { baseUrl: baseUrl || cfg.baseUrl, window: win, endpoints, series: series(rows), totals: totals(rows, endpoints), uptimes: runUptimes(rows), candidates: pickEndpoints(graph).length, indexed: !!graph.snapshotId };
}

function parse(req: Request) {
  const q = new URL(req.url).searchParams;
  const env = q.get("env") || "dev";
  const win = q.get("window") || "24h";
  return { env, win };
}

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const { env, win } = parse(req);
  if (!ENVS.includes(env)) return bad("env must be dev, preview or prod");
  if (!WINDOWS[win]) return bad("window must be 24h or 7d");
  return ok(await payload(p.id, env, win));
}

export async function POST(req: Request, { params }: Ctx) {
  if (limitsOn() && limited(`probe:${clientIp(req)}`, 60, 600000)) return tooMany("probe requests");
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const body = await readJson<{ env?: string; baseUrl?: string; keys?: unknown; window?: string }>(req);
  const env = body.env || "dev";
  if (!ENVS.includes(env)) return bad("env must be dev, preview or prod");
  const win = body.window && WINDOWS[body.window] ? body.window : "24h";
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : undefined;
  const graph = await loadGraph(p.id);
  if (!graph.snapshotId) return bad("Analyse the code first so Arkus knows your endpoints", 409);
  let base: string;
  try { base = (await runProbes({ projectId: p.id, env, graph, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined, keys })).baseUrl; }
  catch (e) { return bad((e as Error).message); }
  return ok(await payload(p.id, env, win, base));
}

export async function DELETE(req: Request, { params }: Ctx) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const { env, win } = parse(req);
  if (!ENVS.includes(env)) return bad("env must be dev, preview or prod");
  await clearProbes(p.id, env);
  return ok(await payload(p.id, env, WINDOWS[win] ? win : "24h"));
}
