// DB access for blueprints: latest version, save next version, activity log.
import { prisma, j } from "@/lib/db";
import { validateBlueprint, type Blueprint, type Issue } from "./schema";

export type BlueprintRow = { id: string; version: number; prompt: string; createdAt: Date };

export async function latestBlueprint(projectId: string): Promise<{ blueprint: Blueprint; version: number; prompt: string; issues: Issue[] } | null> {
  const row = await prisma.blueprint.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!row) return null;
  const { blueprint, issues } = validateBlueprint(j<unknown>(row.content, {}));
  if (!blueprint) return null;
  return { blueprint, version: row.version, prompt: row.prompt, issues };
}

export async function listVersions(projectId: string): Promise<(BlueprintRow & { name: string; entities: number; endpoints: number; pages: number })[]> {
  const rows = await prisma.blueprint.findMany({ where: { projectId }, orderBy: { version: "desc" }, select: { id: true, version: true, prompt: true, createdAt: true, content: true } });
  return rows.map((r) => {
    const c = j<Partial<Blueprint>>(r.content, {});
    return { id: r.id, version: r.version, prompt: r.prompt, createdAt: r.createdAt, name: c.name ?? "", entities: c.entities?.length ?? 0, endpoints: c.endpoints?.length ?? 0, pages: c.pages?.length ?? 0 };
  });
}

export async function saveBlueprintVersion(projectId: string, blueprint: Blueprint, prompt: string): Promise<{ id: string; version: number }> {
  const last = await prisma.blueprint.findFirst({ where: { projectId }, orderBy: { version: "desc" }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  const row = await prisma.blueprint.create({ data: { projectId, version, prompt: prompt.slice(0, 4000), content: JSON.stringify(blueprint) } });
  return { id: row.id, version };
}

export async function logDesign(projectId: string, what: string, meta: Record<string, unknown> = {}) {
  await prisma.activity.create({ data: { projectId, kind: "design", what, meta: JSON.stringify(meta) } });
}
