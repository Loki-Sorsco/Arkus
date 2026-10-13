// PATCH /api/projects/:id/db/sources/:sid { name?, schemaOnly? } -> { source } · DELETE -> { ok, removedSnapshots }
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveProject } from "@/lib/arkus/project";
import { patchSource, removeSource } from "@/lib/arkus/dbsources";

type Ctx = { params: Promise<{ id: string; sid: string }> };

async function own(id: string, sid: string) {
  const project = await resolveProject(id);
  if (!project) return { error: NextResponse.json({ error: "project_not_found" }, { status: 404 }) };
  const source = await prisma.source.findFirst({ where: { id: sid, projectId: project.id, kind: "db" } });
  if (!source) return { error: NextResponse.json({ error: "source_not_found" }, { status: 404 }) };
  return { project, source };
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id, sid } = await params;
  const o = await own(id, sid); if ("error" in o) return o.error;
  let body: { name?: string; schemaOnly?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const source = await patchSource(sid, { name: typeof body.name === "string" ? body.name : undefined, schemaOnly: typeof body.schemaOnly === "boolean" ? body.schemaOnly : undefined });
  return NextResponse.json({ source });
}

export async function DELETE(_: Request, { params }: Ctx) {
  const { id, sid } = await params;
  const o = await own(id, sid); if ("error" in o) return o.error;
  const r = await removeSource(sid);
  return NextResponse.json({ ok: true, ...r });
}
