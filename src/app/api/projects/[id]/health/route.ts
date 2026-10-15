// GET  /api/projects/[id]/health[?refresh=1] → { report, cached, indexed, history }
//      history = the last 60 scores ([{ at, overall, areas }], one per computed report) for the trend sparkline.
// POST /api/projects/[id]/health { issueId } → { explanation } (AI; null when AI is off — never fails)
import { loadGraph } from "@/lib/arkus/graph";
import { computeHealth, type HealthReport } from "@/lib/arkus/health";
import { makeReader, SECRET_FILE_RE } from "@/lib/arkus/fs";
import { resolveProject } from "@/lib/arkus/project";
import { prisma, j } from "@/lib/db";
import { chatJSON, untrusted } from "@/lib/llm";
import { bad, ok, readJson } from "../../../_util";

type Ctx = { params: Promise<{ id: string }> };
type HistoryPoint = { at: string; overall: number; areas: Record<string, number> };
const cacheKey = (projectId: string) => `health.${projectId}`;
const historyKey = (projectId: string) => `health.history.${projectId}`;
const HISTORY_CAP = 60;

async function history(projectId: string): Promise<HistoryPoint[]> {
  const row = await prisma.setting.findUnique({ where: { key: historyKey(projectId) } });
  return row ? j<HistoryPoint[]>(row.value, []) : [];
}
async function appendHistory(projectId: string, r: HealthReport): Promise<HistoryPoint[]> {
  const next = [...(await history(projectId)), { at: r.computedAt, overall: r.overall, areas: Object.fromEntries(r.areas.map((a) => [a.area, a.score])) }].slice(-HISTORY_CAP);
  const key = historyKey(projectId), value = JSON.stringify(next);
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  return next;
}

async function cached(projectId: string): Promise<HealthReport | null> {
  const row = await prisma.setting.findUnique({ where: { key: cacheKey(projectId) } });
  return row ? j<HealthReport | null>(row.value, null) : null;
}

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const graph = await loadGraph(p.id);
  if (!graph.snapshotId) return ok({ report: null, cached: false, indexed: false, history: [] });
  if (!refresh) {
    const hit = await cached(p.id);
    if (hit) return ok({ report: hit, cached: true, indexed: true, history: await history(p.id) });
  }
  const report = await computeHealth({ id: p.id, rootPath: p.rootPath }, graph);
  const key = cacheKey(p.id), value = JSON.stringify(report);
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  return ok({ report, cached: false, indexed: true, history: await appendHistory(p.id, report) });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const { issueId } = await readJson<{ issueId?: string }>(req);
  if (!issueId) return bad("issueId required");
  const report = await cached(p.id);
  const issue = report?.issues.find((i) => i.id === issueId);
  if (!issue) return bad("Issue not found; refresh the report", 404);
  // A scrubbed snippet around the line, so the explanation can point at real code (secret values redacted).
  let snippet = "";
  if (issue.file && p.rootPath && !SECRET_FILE_RE.test(issue.file)) {
    try {
      const text = await makeReader(p.rootPath).read(issue.file);
      const lines = text.split(/\r?\n/);
      const at = Math.max(1, issue.line || 1);
      const from = Math.max(0, at - 15), to = Math.min(lines.length, at + 15);
      snippet = lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l.slice(0, 200)}`).join("\n").slice(0, 4000);
    } catch { /* unreadable: explain from the issue text alone */ }
  }
  const system = "You are a patient senior developer explaining one code-health finding to a beginner. Use plain English, short sentences, no jargon without a one-line explanation. Never reveal secret values. Respond as JSON: {\"explanation\": string} with 3 to 6 sentences: what the problem is, why it matters here, and exactly what to change (name the file and lines if given).";
  const user = [`Finding: ${issue.title}`, `Area: ${issue.area}; severity: ${issue.severity}`, `Why: ${issue.why}`, `Suggested fix: ${issue.fix}`, issue.file ? `File: ${issue.file}${issue.line ? `:${issue.line}` : ""}` : "", snippet ? untrusted("code snippet", snippet) : ""].filter(Boolean).join("\n");
  const res = await chatJSON<{ explanation?: unknown }>(system, user, { fast: true, maxTokens: 600 }).catch(() => null);
  const explanation = typeof res?.explanation === "string" && res.explanation.trim() ? res.explanation.trim() : null;
  return ok({ explanation });
}
