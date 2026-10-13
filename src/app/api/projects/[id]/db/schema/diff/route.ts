// GET /api/projects/:id/db/schema/diff?from=<snapshotId>&to=<snapshotId> -> { from, to, diff }
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveProject } from "@/lib/arkus/project";
import { loadSchemaSnapshotTables } from "@/lib/arkus/schemastore";
import { diffSchemas } from "@/lib/arkus/schemadiff";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const sp = new URL(req.url).searchParams;
  const from = sp.get("from"), to = sp.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to snapshot ids are required" }, { status: 400 });
  const snaps = await prisma.snapshot.findMany({ where: { id: { in: [from, to] }, projectId: project.id }, select: { id: true, version: true, kind: true, createdAt: true } });
  const a = snaps.find(s => s.id === from), b = snaps.find(s => s.id === to);
  if (!a || !b) return NextResponse.json({ error: "snapshot_not_found" }, { status: 404 });
  const [before, after] = await Promise.all([loadSchemaSnapshotTables(a.id), loadSchemaSnapshotTables(b.id)]);
  return NextResponse.json({ from: a, to: b, diff: diffSchemas(before, after) });
}
