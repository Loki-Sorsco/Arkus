// POST /api/projects/:id/db/sources/:sid/test -> staged test of the stored (encrypted) connection; updates status/testedAt.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveProject } from "@/lib/arkus/project";
import { testStoredSource } from "@/lib/arkus/dbsources";
import { redact } from "@/lib/arkus/dbconn";

export async function POST(_: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const source = await prisma.source.findFirst({ where: { id: sid, projectId: project.id, kind: "db" } });
  if (!source) return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  try {
    const r = await testStoredSource(sid);
    return NextResponse.json({ ...r.test, source: r.source });
  } catch (e) {
    return NextResponse.json({ ok: false, stages: [], error: redact((e as Error).message) }, { status: 500 });
  }
}
