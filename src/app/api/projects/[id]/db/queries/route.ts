// GET  /api/projects/:id/db/queries?env=dev -> { history: Query[<=50] (newest first), saved: Query[] (all envs' saved, this env first) }
// POST /api/projects/:id/db/queries { action: "save"|"unsave"|"rename"|"delete", id, name? } -> { ok, query? }
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveProject } from "@/lib/arkus/project";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const env = new URL(req.url).searchParams.get("env") || undefined;
  const [history, saved] = await Promise.all([
    prisma.query.findMany({ where: { projectId: project.id, ...(env ? { env } : {}) }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.query.findMany({ where: { projectId: project.id, saved: true }, orderBy: [{ name: "asc" }, { createdAt: "desc" }] }),
  ]);
  const sorted = env ? [...saved.filter(q => q.env === env), ...saved.filter(q => q.env !== env)] : saved;
  return NextResponse.json({ env: env ?? null, history, saved: sorted });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  let body: { action?: string; id?: string; name?: string; saved?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const existing = await prisma.query.findFirst({ where: { id: body.id, projectId: project.id } });
  if (!existing) return NextResponse.json({ error: "query not found" }, { status: 404 });
  // Legacy shape { id, saved, name } maps onto the actions.
  const action = body.action ?? (body.saved === false ? "unsave" : body.saved === true || body.name ? "save" : undefined);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  switch (action) {
    case "save": {
      const query = await prisma.query.update({ where: { id: existing.id }, data: { saved: true, name: name || existing.name || existing.question?.slice(0, 120) || existing.sql.replace(/\s+/g, " ").slice(0, 60) } });
      return NextResponse.json({ ok: true, query });
    }
    case "unsave": return NextResponse.json({ ok: true, query: await prisma.query.update({ where: { id: existing.id }, data: { saved: false } }) });
    case "rename": {
      if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
      return NextResponse.json({ ok: true, query: await prisma.query.update({ where: { id: existing.id }, data: { name, saved: true } }) });
    }
    case "delete": await prisma.query.delete({ where: { id: existing.id } }); return NextResponse.json({ ok: true });
    default: return NextResponse.json({ error: "action must be save | unsave | rename | delete" }, { status: 400 });
  }
}
