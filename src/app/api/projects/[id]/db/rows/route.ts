// GET /api/projects/:id/db/rows?env&table&page&pageSize&sort&dir&filters=<json> → paged, masked rows.
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { connForProject, redact } from "@/lib/arkus/dbconn";
import { loadSchemaTables } from "@/lib/arkus/schemastore";
import { browseRows, type BrowseFilter } from "@/lib/arkus/browse";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const sp = new URL(req.url).searchParams;
  const env = sp.get("env") || "dev";
  const table = sp.get("table");
  if (!table) return NextResponse.json({ error: "table is required" }, { status: 400 });
  let filters: BrowseFilter[] = [];
  if (sp.get("filters")) {
    try { const f = JSON.parse(sp.get("filters")!); filters = Array.isArray(f) ? f : []; }
    catch { return NextResponse.json({ error: "filters must be a JSON array" }, { status: 400 }); }
  }
  const { tables } = await loadSchemaTables(id, env);
  if (!tables.length) return NextResponse.json({ error: "no schema snapshot for this env — connect a database first" }, { status: 404 });
  let pc;
  try { pc = await connForProject(id, env); }
  catch (e) { return NextResponse.json({ error: redact((e as Error).message) }, { status: 400 }); }
  try {
    if (pc.schemaOnly) return NextResponse.json({ error: "schema-only connection", schemaOnly: true }, { status: 403 });
    const result = await browseRows(pc.conn, tables, table, {
      page: Number(sp.get("page") || 1), pageSize: Number(sp.get("pageSize") || 50),
      sort: sp.get("sort") ? { column: sp.get("sort")!, dir: sp.get("dir") === "desc" ? "desc" : "asc" } : undefined,
      filters,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: redact((e as Error).message, pc.config.url) }, { status: 400 });
  } finally {
    await pc.conn.close();
  }
}
