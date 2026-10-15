// Schema-change engine, execution part: `applySchemaChange` validates against the env's snapshot, renders the
// statements, runs them on a writable connection (one transaction on Postgres; MySQL autocommits DDL and
// SQLite runs one statement at a time, so those run sequentially), logs Activity "write" with the SQL and
// re-syncs the schema snapshot through the same syncSource as POST /db/sources/[sid]/sync. `runDdl` is the
// allow-listed raw escape hatch (ALTER TABLE / CREATE INDEX / CREATE TABLE only, never DROP / TRUNCATE).
import { prisma } from "@/lib/db";
import { connForProject, redact, type Engine } from "./dbconn";
import { syncSource } from "./dbsources";
import { loadSchemaTables } from "./schemastore";
import { DdlError, findTable, renderDdl, validateSchemaChange, type SchemaChange } from "./ddl";

export type DdlResult = { ok: true; sql: string[]; table?: string; ms: number; activityId: string; snapshot: { id: string; version: string; reused: boolean } | null; syncError?: string };

async function withWritable<T>(projectId: string, env: string, fn: (pc: Awaited<ReturnType<typeof connForProject>>) => Promise<T>): Promise<T> {
  let pc;
  try { pc = await connForProject(projectId, env, { writable: true }); }
  catch (e) { throw new DdlError(redact((e as Error).message)); }
  try {
    if (pc.schemaOnly) throw new DdlError("This connection is schema only; writes are off for this environment", 403);
    return await fn(pc);
  } finally { await pc.conn.close().catch(() => undefined); }
}

/** Run the statements: Postgres gets them as one multi-statement query inside the driver's BEGIN … COMMIT; others one by one. */
async function runStatements(pc: Awaited<ReturnType<typeof connForProject>>, sql: string[]): Promise<number> {
  const t0 = Date.now();
  try {
    if (pc.conn.engine === "postgres" && sql.length > 1) await pc.conn.query(sql.join(";\n"));
    else for (const s of sql) await pc.conn.query(s);
  } catch (e) { throw new DdlError(redact((e as Error).message, pc.config.url)); }
  return Date.now() - t0;
}

async function finish(projectId: string, env: string, sourceId: string, what: string, sql: string[], ms: number, table?: string): Promise<DdlResult> {
  const activity = await prisma.activity.create({ data: { projectId, env, kind: "write", what: what.slice(0, 200), meta: JSON.stringify({ op: "ddl", table, sql: sql.join(";\n").slice(0, 4000), ms }) } });
  try {
    const s = await syncSource(sourceId);
    return { ok: true, sql, table, ms, activityId: activity.id, snapshot: { id: s.snapshot.id, version: s.snapshot.version, reused: s.reused } };
  } catch (e) {
    return { ok: true, sql, table, ms, activityId: activity.id, snapshot: null, syncError: (e as Error).message };
  }
}

const describe = (c: SchemaChange): string => {
  switch (c.kind) {
    case "create_table": return `Created table ${c.table} (${c.columns.length} columns)`;
    case "rename_table": return `Renamed table ${c.table} to ${c.to}`;
    case "drop_table": return `Dropped table ${c.table}`;
    case "add_column": return `Added column ${c.table}.${c.column} (${c.type}${c.nullable === false ? ", not null" : ""})`;
    case "rename_column": return `Renamed column ${c.table}.${c.column} to ${c.to}`;
    case "alter_column": return `Altered column ${c.table}.${c.column}`;
    case "drop_column": return `Dropped column ${c.table}.${c.column}`;
    case "create_index": return `Created ${c.unique ? "unique " : ""}index on ${c.table} (${c.columns.join(", ")})`;
    case "drop_index": return `Dropped index ${c.name} on ${c.table}`;
  }
};

/** Validate + render without executing (POST /db/schema/preview and the action cards). */
export async function previewSchemaChange(projectId: string, env: string, raw: unknown): Promise<{ change: SchemaChange; sql: string[]; engine: Engine }> {
  const { tables, engine } = await loadSchemaTables(projectId, env);
  if (!tables.length) throw new DdlError("no schema snapshot for this env — connect a database first", 404);
  const eng = (engine ?? "postgres") as Engine;
  const v = validateSchemaChange(raw, tables, eng, { requireConfirm: false });
  return { change: v.change, sql: renderDdl(v.change, eng, v.current), engine: eng };
}

export async function applySchemaChange(projectId: string, env: string, raw: unknown, opts: { confirm?: string } = {}): Promise<DdlResult> {
  const { tables, engine } = await loadSchemaTables(projectId, env);
  if (!tables.length) throw new DdlError("no schema snapshot for this env — connect a database first", 404);
  const eng = (engine ?? "postgres") as Engine;
  const { change, current } = validateSchemaChange(raw, tables, eng, { confirm: opts.confirm });
  const sql = renderDdl(change, eng, current);
  return withWritable(projectId, env, async (pc) => {
    if (pc.conn.engine !== eng) throw new DdlError(`the ${env} connection is ${pc.conn.engine} but the snapshot was taken from ${eng}; re-sync the schema first`);
    const ms = await runStatements(pc, sql);
    return finish(projectId, env, pc.sourceId, describe(change), sql, ms, change.kind === "create_table" ? change.table : findTable(tables, change.table)?.name);
  });
}

const DDL_ALLOW = /^\s*(alter\s+table|create\s+(unique\s+)?index|create\s+table)\b/i;
const DDL_DENY = /\b(drop|truncate|delete|rename\s+to|replace|attach|detach|pragma|grant|revoke|exec(ute)?|load|outfile|dumpfile)\b/i;

/** Lexical check for the run_sql action: one ALTER TABLE / CREATE INDEX / CREATE TABLE statement, nothing destructive. */
export function checkDdl(sql: string): { ok: true; sql: string } | { ok: false; reason: string } {
  let s = String(sql ?? "").normalize("NFKC").trim();
  if (!s) return { ok: false, reason: "empty statement" };
  if (s.length > 8000) return { ok: false, reason: "statement too long" };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return { ok: false, reason: "control characters are not allowed" };
  s = s.replace(/;+\s*$/, "").trim();
  if (s.includes(";")) return { ok: false, reason: "only one statement is allowed" };
  if (/--|\/\*|\*\//.test(s)) return { ok: false, reason: "comments are not allowed" };
  if (!DDL_ALLOW.test(s)) return { ok: false, reason: "only ALTER TABLE, CREATE INDEX and CREATE TABLE can run from here" };
  const code = s.replace(/'(?:[^']|'')*'/g, "''");
  const deny = DDL_DENY.exec(code);
  if (deny) return { ok: false, reason: `${deny[0].toUpperCase()} is not allowed; Arkus never drops or truncates from an action` };
  return { ok: true, sql: s };
}

/** Run one allow-listed DDL statement (see checkDdl) and re-sync the snapshot. */
export async function runDdl(projectId: string, env: string, sql: string): Promise<DdlResult> {
  const c = checkDdl(sql);
  if (!c.ok) throw new DdlError(c.reason);
  const { tables } = await loadSchemaTables(projectId, env);
  if (!tables.length) throw new DdlError("no schema snapshot for this env — connect a database first", 404);
  const alter = /^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w".`]+)/i.exec(c.sql);
  const create = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".`]+)/i.exec(c.sql);
  const bare = (n: string) => n.replace(/["`]/g, "").split(".").pop()!.toLowerCase();
  if (alter && !findTable(tables, bare(alter[1]))) throw new DdlError(`unknown table "${bare(alter[1])}" — it is not in the ${env} schema snapshot`);
  if (create && findTable(tables, bare(create[1])) && !/if\s+not\s+exists/i.test(c.sql)) throw new DdlError(`table "${bare(create[1])}" already exists`);
  const table = alter ? findTable(tables, bare(alter[1]))?.name : create ? bare(create[1]) : undefined;
  return withWritable(projectId, env, async (pc) => {
    const ms = await runStatements(pc, [c.sql]);
    return finish(projectId, env, pc.sourceId, `Ran DDL: ${c.sql.slice(0, 150)}`, [c.sql], ms, table);
  });
}
