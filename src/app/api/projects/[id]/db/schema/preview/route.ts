// POST /api/projects/:id/db/schema/preview { env, change: SchemaChange } → { sql: string[], change } — validates
// against the snapshot and renders the statements for the engine. Never executes anything.
import { NextResponse } from "next/server";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { resolveProject } from "@/lib/arkus/project";
import { isEnv } from "@/lib/arkus/dbsources";
import { DdlError } from "@/lib/arkus/ddl";
import { previewSchemaChange } from "@/lib/arkus/ddl-apply";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  if (limitsOn() && limited(`schema-preview:${clientIp(req)}`, 120, 600000)) return tooMany("preview requests");
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  let body: { env?: unknown; change?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const env = isEnv(body.env) ? body.env : "dev";
  if (!body.change || typeof body.change !== "object") return NextResponse.json({ error: "change is required" }, { status: 400 });
  try {
    const r = await previewSchemaChange(p.id, env, body.change);
    return NextResponse.json({ sql: r.sql, change: r.change, engine: r.engine });
  } catch (e) {
    if (e instanceof DdlError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
