// POST { targetDir, force?, database? } → write the starter repo, flip project to connected
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scaffoldProject } from "@/lib/arkus/architect/scaffold";
import { latestBlueprint, logDesign } from "@/lib/arkus/architect/store";

const Body = z.object({
  targetDir: z.string().min(3).max(1000),
  force: z.boolean().optional(),
  database: z.enum(["sqlite", "postgresql", "mysql"]).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  const latest = await latestBlueprint(id);
  if (!latest) return NextResponse.json({ error: "no_blueprint" }, { status: 409 });

  try {
    const res = await scaffoldProject({ bp: latest.blueprint, targetDir: parsed.data.targetDir, force: parsed.data.force, stack: { database: parsed.data.database }, blueprintVersion: latest.version });
    await prisma.project.update({ where: { id }, data: { mode: "connected", rootPath: res.targetDir, status: "new" } });
    const existing = await prisma.source.findFirst({ where: { projectId: id, kind: "repo", env: "dev" } });
    if (existing) await prisma.source.update({ where: { id: existing.id }, data: { config: JSON.stringify({ path: res.targetDir }), status: "untested" } });
    else await prisma.source.create({ data: { projectId: id, kind: "repo", env: "dev", name: "repo", config: JSON.stringify({ path: res.targetDir }) } });
    await logDesign(id, `Scaffolded ${res.files.length} files into ${res.targetDir} (blueprint v${latest.version})`, { targetDir: res.targetDir, files: res.files.length, version: latest.version });
    return NextResponse.json({ targetDir: res.targetDir, files: res.files, nextSteps: res.nextSteps, version: latest.version });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /not empty/.test(msg) ? 409 : /outside|unsafe|absolute/.test(msg) ? 400 : 500;
    return NextResponse.json({ error: "scaffold_failed", message: msg }, { status });
  }
}
