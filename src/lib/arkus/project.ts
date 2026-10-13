import { prisma, j } from "../db";
import { aiReady } from "../llm";
export function resolveProject(idOrSlug: string) {
  return prisma.project.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
}
export const shapePlan = (p: { changes: string; decisions: string; impact: string; checks: string; comments: string } & Record<string, unknown>) => ({ ...p, changes: j(p.changes, []), decisions: j(p.decisions, {}), impact: j(p.impact, {}), checks: j(p.checks, []), comments: j(p.comments, []) });

/** Public config shape: never url / urlEnc. Db sources expose engine, display, schemaOnly, local; repo sources their path. */
function redact(cfg: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ["engine", "display", "schemaOnly", "local", "database", "host", "path", "branch"]) if (cfg[k] !== undefined) out[k] = cfg[k];
  if (!out.display && typeof cfg.url === "string" && cfg.url) out.display = String(cfg.url).replace(/:\/\/([^:@/]*):[^@]*@/, "://$1@").replace(/password=[^&\s]+/gi, "password=***");
  return out;
}

/** Full project detail used by the workspace shell and GET /api/projects/[id]. */
export async function projectDetail(idOrSlug: string) {
  const p = await resolveProject(idOrSlug);
  if (!p) return null;
  const [sources, snapshots, plans, blueprint] = await Promise.all([
    prisma.source.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } }),
    prisma.snapshot.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, kind: true, version: true, status: true, stats: true, createdAt: true } }),
    prisma.plan.findMany({ where: { projectId: p.id }, orderBy: { no: "desc" }, select: { no: true, title: true, pipeline: true, risk: true, updatedAt: true } }),
    prisma.blueprint.findFirst({ where: { projectId: p.id }, orderBy: { version: "desc" }, select: { version: true, createdAt: true } }),
  ]);
  return {
    ...p, stack: j<Record<string, unknown>>(p.stack, {}),
    sources: sources.map((s) => { const cfg = redact(j<Record<string, unknown>>(s.config, {})); return { id: s.id, kind: s.kind, env: s.env, name: s.name, status: s.status, lastError: s.lastError, testedAt: s.testedAt, createdAt: s.createdAt, config: cfg, engine: (cfg.engine as string | undefined) ?? null, display: (cfg.display as string | undefined) ?? "", schemaOnly: Boolean(cfg.schemaOnly) }; }),
    snapshots: snapshots.map((s) => ({ ...s, stats: j<Record<string, unknown>>(s.stats, {}) })),
    plans, blueprint,
    draftPlans: plans.filter((x) => x.pipeline !== "shipped" && x.pipeline !== "failed").length,
    ai: await aiReady(),
  };
}
