// GET  /api/projects/:id/db/sources            -> { sources: PublicSource[] } (all envs, each with its latest schema snapshot)
// POST /api/projects/:id/db/sources { env, engine?, url, schemaOnly?, name? } -> test -> save (encrypted) -> introspect -> snapshot
//      -> { ok, source, snapshot, test } · 422 { ok:false, source, test } when the test fails.
import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/arkus/project";
import { isEnv, listDbSources, upsertDbSource } from "@/lib/arkus/dbsources";
import { redact, type Engine } from "@/lib/arkus/dbconn";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  return NextResponse.json({ sources: await listDbSources(project.id) });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  let body: { env?: string; engine?: Engine; url?: string; schemaOnly?: boolean; name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  if (!body?.url || typeof body.url !== "string") return NextResponse.json({ error: "url is required" }, { status: 400 });
  const env = isEnv(body.env) ? body.env : "dev";
  const engine = body.engine && ["postgres", "mysql", "sqlite"].includes(body.engine) ? body.engine : undefined;
  try {
    const r = await upsertDbSource({ projectId: project.id, env, engine, url: body.url, schemaOnly: Boolean(body.schemaOnly), name: body.name });
    if (!r.ok) return NextResponse.json({ ok: false, source: r.source, test: r.test, error: r.error ?? r.test.stages.find(s => !s.ok)?.error ?? "connection failed" }, { status: r.error ? 500 : 422 });
    return NextResponse.json({ ok: true, source: r.source, snapshot: r.snapshot, test: r.test });
  } catch (e) {
    return NextResponse.json({ error: redact((e as Error).message, body.url) }, { status: 400 });
  }
}
