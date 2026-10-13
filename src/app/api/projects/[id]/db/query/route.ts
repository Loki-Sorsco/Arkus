// POST /api/projects/:id/db/query
//   { env, sql }      → guardRead → execute (read-only) → { columns, rows (masked), ms, truncated } + Query log row
//   { env, question } → nl2sql → { sql, explanation, assumptions } WITHOUT executing (user clicks Run)
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { connForProject, redact, type Engine } from "@/lib/arkus/dbconn";
import { loadSchemaTables } from "@/lib/arkus/schemastore";
import { guardRead, MAX_LIMIT } from "@/lib/arkus/sqlguard";
import { maskRows } from "@/lib/arkus/browse";
import { nlToSql } from "@/lib/arkus/nl2sql";

type Body = { env?: string; sql?: string; question?: string; glossary?: Record<string, string> };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const env = body.env || "dev";
  const { tables, engine } = await loadSchemaTables(id, env);
  if (!tables.length) return NextResponse.json({ error: "no schema snapshot for this env — connect a database first" }, { status: 404 });
  const eng = (engine ?? "postgres") as Engine;
  const allowed = tables.map(t => t.name);

  // ---- English → SQL (never executes)
  if (typeof body.question === "string" && !body.sql) {
    const r = await nlToSql({ question: body.question, tables, engine: eng, glossary: body.glossary });
    if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason, starters: r.starters, sql: r.sql ?? null, explanation: r.explanation ?? null }, { status: r.reason === "AI not configured" ? 200 : 422 });
    return NextResponse.json({ ok: true, sql: r.sql, explanation: r.explanation, assumptions: r.assumptions, tables: r.tables, question: body.question });
  }

  if (typeof body.sql !== "string" || !body.sql.trim()) return NextResponse.json({ error: "sql or question is required" }, { status: 400 });
  const g = guardRead(body.sql, allowed, { engine: eng });
  if (!g.ok) {
    await prisma.query.create({ data: { projectId: id, env, sql: body.sql.slice(0, 20000), question: body.question ?? null, status: "blocked", rows: 0, ms: 0 } });
    return NextResponse.json({ ok: false, blocked: true, reason: g.reason }, { status: 422 });
  }

  let pc;
  try { pc = await connForProject(id, env); }
  catch (e) {
    await prisma.query.create({ data: { projectId: id, env, sql: g.sql, question: body.question ?? null, status: "error", rows: 0, ms: 0 } });
    return NextResponse.json({ error: redact((e as Error).message) }, { status: 400 });
  }
  try {
    if (pc.schemaOnly) {
      await prisma.query.create({ data: { projectId: id, env, sql: g.sql, question: body.question ?? null, status: "blocked", rows: 0, ms: 0 } });
      return NextResponse.json({ error: "schema-only connection", schemaOnly: true }, { status: 403 });
    }
    const res = await pc.conn.query(g.sql);
    const masked = maskRows(res.rows, res.fields);
    const q = await prisma.query.create({ data: { projectId: id, env, sql: g.sql, question: body.question ?? null, status: "ok", rows: res.rows.length, ms: res.ms } });
    await prisma.activity.create({ data: { projectId: id, env, kind: "query", what: body.question ? `Asked: ${body.question.slice(0, 120)}` : `Ran query on ${g.tables.join(", ") || "scalar"}`, meta: JSON.stringify({ queryId: q.id, rows: res.rows.length, ms: res.ms }) } });
    return NextResponse.json({ ok: true, id: q.id, sql: g.sql, columns: masked.columns, hidden: masked.hidden, masked: masked.masked, rows: masked.rows, rowCount: res.rows.length, ms: res.ms, truncated: res.rows.length >= Math.min(g.limit, MAX_LIMIT), limit: g.limit });
  } catch (e) {
    const msg = redact((e as Error).message, pc.config.url);
    await prisma.query.create({ data: { projectId: id, env, sql: g.sql, question: body.question ?? null, status: "error", rows: 0, ms: 0 } });
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  } finally {
    await pc.conn.close();
  }
}
