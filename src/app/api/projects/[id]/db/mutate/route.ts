// POST /api/projects/:id/db/mutate { env, mutation } → applyMutation (update one row's columns, insert a
// row, delete a row) on the env's database. Identifiers come from the stored schema snapshot, values
// are bound parameters, update / delete must match exactly one row. 400 { error } on refusal,
// 403 on schema-only sources, 409 when the optimistic guard / pk matched no row.
import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/arkus/project";
import { redact } from "@/lib/arkus/dbconn";
import { applyMutation, MutationError, type Mutation } from "@/lib/arkus/mutate";

type Body = { env?: string; mutation?: Mutation };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const env = typeof body.env === "string" && body.env ? body.env : "dev";
  if (!body.mutation || typeof body.mutation !== "object") return NextResponse.json({ error: "mutation is required" }, { status: 400 });
  try {
    const result = await applyMutation(resolved.id, env, body.mutation);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof MutationError) return NextResponse.json({ ok: false, error: e.message, ...e.extra }, { status: e.status });
    return NextResponse.json({ ok: false, error: redact((e as Error).message) }, { status: 500 });
  }
}
