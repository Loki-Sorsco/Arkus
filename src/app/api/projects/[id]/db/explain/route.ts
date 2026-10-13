// POST /api/projects/:id/db/explain { env, sql } → guarded EXPLAIN (postgres/mysql) or EXPLAIN QUERY PLAN (sqlite).
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { connForProject, redact, type Engine } from "@/lib/arkus/dbconn";
import { loadSchemaTables } from "@/lib/arkus/schemastore";
import { guardRead } from "@/lib/arkus/sqlguard";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  let body: { env?: string; sql?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json body" }, { status: 400 }); }
  const env = body.env || "dev";
  if (typeof body.sql !== "string" || !body.sql.trim()) return NextResponse.json({ error: "sql is required" }, { status: 400 });
  const { tables, engine } = await loadSchemaTables(id, env);
  if (!tables.length) return NextResponse.json({ error: "no schema snapshot for this env — connect a database first" }, { status: 404 });
  const eng = (engine ?? "postgres") as Engine;
  const g = guardRead(body.sql, tables.map(t => t.name), { engine: eng });
  if (!g.ok) return NextResponse.json({ ok: false, blocked: true, reason: g.reason }, { status: 422 });

  let pc;
  try { pc = await connForProject(id, env); }
  catch (e) { return NextResponse.json({ error: redact((e as Error).message) }, { status: 400 }); }
  try {
    // EXPLAIN without ANALYZE never executes the query; plain-text form so every engine returns rows of strings.
    // Plain EXPLAIN works on MySQL 5.7+ and MariaDB (FORMAT=TREE is 8.0.16+ only); tabular rows are flattened to one line each.
    const prefix = pc.conn.engine === "sqlite" ? "EXPLAIN QUERY PLAN " : pc.conn.engine === "mysql" ? "EXPLAIN " : "EXPLAIN (FORMAT TEXT) ";
    const res = await pc.conn.query(prefix + g.sql);
    const plan = res.rows.map(r => {
      if (pc.conn.engine === "sqlite") return `${"  ".repeat(Number(r.parent) ? 1 : 0)}${String(r.detail ?? "")}`;
      if (pc.conn.engine === "mysql") return ["select_type", "table", "type", "key", "rows", "Extra"].map(k => `${k}=${r[k] ?? "-"}`).join("  ");
      return String(Object.values(r)[0] ?? "");
    });
    return NextResponse.json({ ok: true, sql: g.sql, engine: pc.conn.engine, plan, raw: res.rows, ms: res.ms });
  } catch (e) {
    return NextResponse.json({ ok: false, error: redact((e as Error).message, pc.config.url) }, { status: 400 });
  } finally {
    await pc.conn.close();
  }
}
