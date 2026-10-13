// POST /api/projects/:id/db/test  { engine?, url, schemaOnly? } → staged connection test (nothing saved).
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { testConnection, redact, type DbConfig } from "@/lib/arkus/dbconn";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  let body: Partial<DbConfig>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  if (!body?.url || typeof body.url !== "string") return NextResponse.json({ error: "url is required" }, { status: 400 });
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  try {
    const result = await testConnection({ engine: body.engine, url: body.url, schemaOnly: Boolean(body.schemaOnly) }, project.rootPath ?? undefined);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, stages: [], error: redact((e as Error).message, body.url) }, { status: 500 });
  }
}
