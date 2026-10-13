import { prisma } from "@/lib/db";
import { projectDetail, resolveProject } from "@/lib/arkus/project";
import { bad, ok, readJson } from "../../_util";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const { id } = await params;
  const d = await projectDetail(id);
  if (!d) return bad("Not found", 404);
  return ok(d);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const body = await readJson<{ name?: string }>(req);
  const updated = await prisma.project.update({ where: { id: p.id }, data: { ...(body.name ? { name: body.name.trim() } : {}) } });
  return ok(updated);
}

export async function DELETE(_: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  await prisma.project.delete({ where: { id: p.id } });
  return ok({ ok: true });
}
