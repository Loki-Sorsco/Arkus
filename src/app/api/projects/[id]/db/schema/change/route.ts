// POST /api/projects/:id/db/schema/change { env, change: SchemaChange, confirm? } → applySchemaChange →
// { ok, sql: string[], table?, snapshot } · 400 { ok:false, error } on refusal · 428 when a drop needs the typed
// table name · 403 on schema-only sources. Prod is gated client-side like every other write.
import { NextResponse } from "next/server";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { resolveProject } from "@/lib/arkus/project";
import { redact } from "@/lib/arkus/dbconn";
import { isEnv } from "@/lib/arkus/dbsources";
import { DdlError } from "@/lib/arkus/ddl";
import { applySchemaChange } from "@/lib/arkus/ddl-apply";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  if (limitsOn() && limited(`schema:${clientIp(req)}`, 60, 600000)) return tooMany("schema changes");
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  let body: { env?: unknown; change?: unknown; confirm?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const env = isEnv(body.env) ? body.env : "dev";
  if (!body.change || typeof body.change !== "object") return NextResponse.json({ ok: false, error: "change is required" }, { status: 400 });
  try {
    const r = await applySchemaChange(p.id, env, body.change, { confirm: typeof body.confirm === "string" ? body.confirm : undefined });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof DdlError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    return NextResponse.json({ ok: false, error: redact((e as Error).message) }, { status: 500 });
  }
}
