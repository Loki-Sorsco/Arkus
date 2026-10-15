// GET latest blueprint (+ versions) · POST { idea, answers?, stackHint? } → generate + save version n+1
import { resolveProject } from "@/lib/arkus/project";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { generateBlueprint } from "@/lib/arkus/architect/generate";
import { latestBlueprint, listVersions, saveBlueprintVersion, logDesign } from "@/lib/arkus/architect/store";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const latest = await latestBlueprint(id);
  const versions = await listVersions(id);
  const lastGen = await prisma.activity.findFirst({ where: { projectId: id, kind: "design" }, orderBy: { createdAt: "desc" } });
  const genMeta = (() => { try { return JSON.parse(lastGen?.meta || "{}") as { aiUsed?: boolean; template?: string | null }; } catch { return {}; } })();
  return NextResponse.json({
    project,
    aiUsed: genMeta.aiUsed ?? true,
    template: genMeta.template ?? null,
    blueprint: latest?.blueprint ?? null,
    version: latest?.version ?? 0,
    prompt: latest?.prompt ?? null,
    checks: latest?.blueprint.checks ?? [],
    issues: latest?.issues ?? [],
    versions,
  });
}

const Body = z.object({
  idea: z.string().min(4).max(4000),
  answers: z.record(z.string(), z.string().max(2000)).optional(),
  stackHint: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: Ctx) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  const { idea, answers, stackHint } = parsed.data;

  const gen = await generateBlueprint({ idea, answers, stackHint });
  const prompt = [idea, ...Object.entries(answers ?? {}).map(([k, v]) => `${k}: ${v}`)].join("\n");
  const { version } = await saveBlueprintVersion(id, gen.blueprint, prompt);
  if (!project.name.trim() || project.name === "Untitled") await prisma.project.update({ where: { id }, data: { name: gen.blueprint.name } });
  await prisma.project.update({ where: { id }, data: { mode: "designed", stack: JSON.stringify(gen.blueprint.stack) } });
  await logDesign(id, `Generated blueprint v${version} (${gen.aiUsed ? "AI" : `template:${gen.template}`})`, { version, aiUsed: gen.aiUsed, template: gen.template ?? null });

  return NextResponse.json({ blueprint: gen.blueprint, version, checks: gen.checks, aiUsed: gen.aiUsed, template: gen.template ?? null, issues: gen.issues });
}
