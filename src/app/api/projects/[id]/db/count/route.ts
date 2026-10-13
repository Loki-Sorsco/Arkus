// POST /api/projects/:id/db/count { env, table } -> exact SELECT count(*) for a table that exists in the schema snapshot.
// The identifier is taken from the snapshot (never from raw input) and quoted per engine. Refused on schema-only sources.
import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/arkus/project";
import { connForProject, redact } from "@/lib/arkus/dbconn";
import { loadSchemaTables } from "@/lib/arkus/schemastore";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  let body: { env?: string; table?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const env = body.env || "dev";
  if (typeof body.table !== "string" || !body.table.trim()) return NextResponse.json({ error: "table is required" }, { status: 400 });
  const { tables } = await loadSchemaTables(project.id, env);
  const want = body.table.trim().toLowerCase();
  const t = tables.find(x => x.name.toLowerCase() === want) ?? tables.find(x => x.name.toLowerCase().split(".").pop() === want);
  if (!t) return NextResponse.json({ error: `unknown table "${body.table}"` }, { status: 404 });
  let pc;
  try { pc = await connForProject(project.id, env); }
  catch (e) { return NextResponse.json({ error: redact((e as Error).message) }, { status: 400 }); }
  try {
    if (pc.schemaOnly) return NextResponse.json({ error: "schema-only connection", schemaOnly: true }, { status: 403 });
    const qualified = t.name.split(".").map(p => pc.conn.quoteId(p)).join(".");
    const res = await pc.conn.query(`SELECT count(*) AS n FROM ${qualified}`);
    return NextResponse.json({ table: t.name, count: Number(res.rows[0]?.n ?? 0), ms: res.ms });
  } catch (e) {
    return NextResponse.json({ error: redact((e as Error).message, pc.config.url) }, { status: 400 });
  } finally {
    await pc.conn.close();
  }
}
