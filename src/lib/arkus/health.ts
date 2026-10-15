// Health report: deterministic checks over the graph plus a light file scan. Tells a developer
// (including a beginner) how healthy the frontend, API, backend/database and security are,
// what is wrong, why it matters and what to do. Never changes code; never needs AI.
import type { LoadedGraph } from "./graph";
import { apiChecks, databaseChecks, frontendChecks, securityChecks } from "./health-checks";
import { npmAudit, scanFiles, type AuditSummary, type ScannedFile } from "./health-scan";
import { computeDrift } from "./drift";

export type Severity = "high" | "medium" | "low" | "info";
export type Area = "frontend" | "backend" | "api" | "database" | "security";
export interface Issue {
  id: string;
  area: Area;
  severity: Severity;
  title: string;
  why: string;        // one plain sentence
  fix: string;        // concrete action
  file?: string;
  line?: number;
  nodeKey?: string;   // lets the UI open the page / API / table
  count?: number;
}
export interface AreaScore { area: Area; score: number; issues: number; summary: string }
export interface HealthReport {
  computedAt: string;
  overall: number;
  areas: AreaScore[];
  issues: Issue[];
  stats: { filesScanned: number; endpoints: number; pages: number; tables: number; bindings: number; audit: AuditSummary; durationMs: number; indexedAt: string | null; bySeverity: Record<Severity, number> };
}

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];
const PENALTY: Record<Severity, number> = { high: 15, medium: 6, low: 2, info: 0 };
/** The four scored areas; "backend" issues (if any) count towards database. */
const SCORED: { area: Area; weight: number; label: string }[] = [
  { area: "security", weight: 0.3, label: "security" },
  { area: "api", weight: 0.25, label: "API" },
  { area: "database", weight: 0.2, label: "backend and database" },
  { area: "frontend", weight: 0.25, label: "frontend" },
];
export const scoredArea = (a: Area): Area => (a === "backend" ? "database" : a);

export function scoreIssues(issues: Issue[]): { overall: number; areas: AreaScore[] } {
  const areas = SCORED.map(({ area, weight, label }) => {
    const mine = issues.filter((i) => scoredArea(i.area) === area);
    const score = Math.max(0, Math.round(100 - mine.reduce((s, i) => s + PENALTY[i.severity], 0)));
    const counts = countBySeverity(mine);
    return { area, score, issues: mine.length, summary: summarise(label, counts), weight };
  });
  const overall = Math.round(areas.reduce((s, a) => s + a.score * a.weight, 0) / areas.reduce((s, a) => s + a.weight, 0));
  return { overall, areas: areas.map(({ area, score, issues, summary }) => ({ area, score, issues, summary })) };
}

export const countBySeverity = (issues: Issue[]): Record<Severity, number> => {
  const c: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const i of issues) c[i.severity]++;
  return c;
};

function summarise(label: string, c: Record<Severity, number>): string {
  const real = c.high + c.medium + c.low;
  if (!real) return c.info ? `No problems found in ${label}; ${c.info} note${c.info === 1 ? "" : "s"} to read.` : `No problems found in ${label}.`;
  const parts: string[] = [];
  if (c.high) parts.push(`${c.high} serious`);
  if (c.medium) parts.push(`${c.medium} worth fixing`);
  if (c.low) parts.push(`${c.low} minor`);
  return `${parts.join(", ")} issue${real === 1 ? "" : "s"} in ${label}.`;
}

/** Deterministic health report for one project. `graph` comes from loadGraph(projectId). */
export async function computeHealth(project: { id: string; rootPath: string | null }, graph: LoadedGraph): Promise<HealthReport> {
  const t0 = Date.now();
  let files = new Map<string, ScannedFile>();
  let audit: AuditSummary = null;
  if (project.rootPath) {
    const priority = graph.nodes.filter((n) => n.file && (n.type === "endpoint" || n.type === "screen" || n.type === "component" || n.type === "apicall")).map((n) => n.file!);
    [files, audit] = await Promise.all([
      scanFiles(project.rootPath, priority).catch(() => new Map<string, ScannedFile>()),
      npmAudit(project.rootPath).catch(() => null),
    ]);
  }
  const issues: Issue[] = [
    ...securityChecks(graph, files, audit),
    ...apiChecks(graph, files),
    ...frontendChecks(graph, files),
    ...databaseChecks(graph),
    ...(await driftIssue(project.id)),
  ];
  dedupeIds(issues);
  issues.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.area.localeCompare(b.area) || a.title.localeCompare(b.title));
  const { overall, areas } = scoreIssues(issues);
  const count = (t: string) => graph.nodes.filter((n) => n.type === t).length;
  return {
    computedAt: new Date().toISOString(), overall, areas, issues,
    stats: { filesScanned: files.size, endpoints: count("endpoint"), pages: count("screen"), tables: count("table"), bindings: graph.bindings.length, audit, durationMs: Date.now() - t0, indexedAt: graph.createdAt, bySeverity: countBySeverity(issues) },
  };
}

/** Code schema vs live database, when both exist (cheap: two snapshot reads). */
async function driftIssue(projectId: string): Promise<Issue[]> {
  try {
    const d = await computeDrift(projectId);
    if (!d.diff || !d.diff.counts.total) return [];
    const c = d.diff.counts;
    const bits: string[] = [];
    if (c.removedTables) bits.push(`${c.removedTables} table${c.removedTables === 1 ? "" : "s"} only in code`);
    if (c.addedTables) bits.push(`${c.addedTables} table${c.addedTables === 1 ? "" : "s"} only in the database`);
    if (c.addedColumns + c.removedColumns + c.changedColumns) bits.push(`${c.addedColumns + c.removedColumns + c.changedColumns} column difference${c.addedColumns + c.removedColumns + c.changedColumns === 1 ? "" : "s"}`);
    return [{ id: "database:drift", area: "database", severity: "medium", title: "Code and database schema do not match", why: `The ${d.env} database differs from what the code declares (${bits.join(", ")}), so queries can fail or silently miss columns.`, fix: "Run your pending migrations (for Prisma: `npx prisma migrate dev`) or update the schema in code to match; open Database > Drift to see each difference.", count: c.total }];
  } catch { return []; }
}

function dedupeIds(issues: Issue[]) {
  const seen = new Map<string, number>();
  for (const i of issues) { const n = seen.get(i.id) || 0; seen.set(i.id, n + 1); if (n) i.id = `${i.id}~${n}`; }
}
