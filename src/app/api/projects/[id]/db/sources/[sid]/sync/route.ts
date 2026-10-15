// POST /api/projects/:id/db/sources/:sid/sync -> re-introspect -> { snapshot, diff, reused, source }
import { NextResponse } from "next/server";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveProject } from "@/lib/arkus/project";
import { syncSource } from "@/lib/arkus/dbsources";
import { redact } from "@/lib/arkus/dbconn";

export async function POST(_: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id, sid } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const source = await prisma.source.findFirst({ where: { id: sid, projectId: project.id, kind: "db" } });
  if (!source) return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  try {
    const r = await syncSource(sid);
    return NextResponse.json({ ok: true, snapshot: { id: r.snapshot.id, version: r.snapshot.version, stats: r.snapshot.stats }, diff: r.diff, reused: r.reused, previousSnapshotId: r.previousSnapshotId, source: r.source });
  } catch (e) {
    return NextResponse.json({ ok: false, error: redact((e as Error).message) }, { status: 400 });
  }
}
