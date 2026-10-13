// GET /api/projects/:id/db/tables?env=dev → tables from the latest schema snapshot (no live connection).
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { loadSchemaTables } from "@/lib/arkus/schemastore";
import { isPiiColumn, isSecretColumn } from "@/lib/arkus/browse";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const env = new URL(req.url).searchParams.get("env") || "dev";
  const { tables, snapshotId, version, createdAt, engine } = await loadSchemaTables(id, env);
  return NextResponse.json({
    env, engine: engine ?? null, snapshot: snapshotId ? { id: snapshotId, version, createdAt } : null,
    tables: tables.map(t => ({
      name: t.name, rowEstimate: t.rowEstimate ?? null, indexes: t.indexes ?? [],
      columns: t.columns.map(c => ({ ...c, secret: isSecretColumn(c.name), pii: isPiiColumn(c.name) })),
    })),
  });
}
