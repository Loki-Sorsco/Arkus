// GET /api/projects/:id/db/schema/history?env=dev -> { env, snapshots: [{ id, version, createdAt, stats, diffFromPrevious }] } newest first (<= 20)
import { NextResponse } from "next/server";
import { prisma, j } from "@/lib/db";
import { resolveProject } from "@/lib/arkus/project";
import { loadSchemaSnapshotTables } from "@/lib/arkus/schemastore";
import { diffSchemas, type SchemaDiff } from "@/lib/arkus/schemadiff";
import type { TableFact } from "@/lib/arkus/types";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const env = new URL(req.url).searchParams.get("env") || "dev";
  const source = await prisma.source.findFirst({ where: { projectId: project.id, kind: "db", env }, orderBy: { createdAt: "desc" } });
  if (!source) return NextResponse.json({ env, source: null, snapshots: [] });
  const snaps = await prisma.snapshot.findMany({ where: { projectId: project.id, sourceId: source.id, kind: "schema", status: "ready" }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, version: true, createdAt: true, stats: true } });
  const tables = new Map<string, TableFact[]>();
  for (const s of snaps) tables.set(s.id, await loadSchemaSnapshotTables(s.id));
  const out = snaps.map((s, i) => {
    const prev = snaps[i + 1];
    const diffFromPrevious: SchemaDiff | null = prev ? diffSchemas(tables.get(prev.id)!, tables.get(s.id)!) : null;
    return { id: s.id, version: s.version, createdAt: s.createdAt, stats: j<Record<string, unknown>>(s.stats, {}), previousId: prev?.id ?? null, diffFromPrevious };
  });
  return NextResponse.json({ env, source: { id: source.id, name: source.name }, snapshots: out });
}
