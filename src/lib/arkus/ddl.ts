// Schema changes to the user's database from AI actions: ADD COLUMN (validated against the snapshot,
// identifiers quoted per engine, type checked against the engine's vocabulary) and a tiny allow-listed
// raw-DDL path (ALTER TABLE / CREATE INDEX / CREATE TABLE only, never DROP / TRUNCATE / DELETE).
// Every change runs on a writable connection, leaves an Activity "write" row, then re-syncs the schema
// snapshot through the same syncSource used by POST /db/sources/[sid]/sync.
import { prisma } from "@/lib/db";
import { connForProject, redact, type Engine } from "./dbconn";
import { syncSource } from "./dbsources";
import { loadSchemaTables } from "./schemastore";
import { isSecretColumn } from "./browse";
import { MutationError } from "./mutate";
import type { TableFact } from "./types";

export type AddColumnInput = { table: string; column: string; type: string; nullable: boolean; defaultValue?: string | number | boolean | null };
export type DdlResult = { ok: true; sql: string; table?: string; ms: number; activityId: string; snapshot: { id: string; version: string; reused: boolean } | null; syncError?: string };

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

// Column types the three engines accept, as the model is told to use them. A parenthesised size /
// precision is allowed after any of them ("varchar(120)", "numeric(10,2)").
const TYPES: Record<Engine, RegExp> = {
  postgres: /^(text|varchar|character varying|char|character|citext|uuid|boolean|bool|smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|real|double precision|float4|float8|numeric|decimal|money|date|time|timetz|timestamp|timestamptz|timestamp with(?:out)? time zone|interval|json|jsonb|bytea|inet)(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?(\s*\[\])?$/i,
  mysql: /^(varchar|char|text|tinytext|mediumtext|longtext|tinyint|smallint|mediumint|int|integer|bigint|boolean|bool|float|double|decimal|numeric|date|datetime|timestamp|time|year|json|blob|tinyblob|mediumblob|longblob|binary|varbinary|enum)(\s*\(\s*[^()]{1,120}\s*\))?(\s+unsigned)?$/i,
  sqlite: /^(text|integer|int|real|numeric|blob|boolean|bool|datetime|date|timestamp|varchar|char|bigint|double|float|decimal|json)(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?$/i,
};

/** Validate a column type for the engine; returns the normalised type or throws. */
export function checkColumnType(engine: Engine, type: string): string {
  const t = String(type ?? "").trim().replace(/\s+/g, " ");
  if (!t || t.length > 80 || !TYPES[engine].test(t)) throw new MutationError(`"${t || "?"}" is not a column type ${engine} accepts here. Use e.g. ${engine === "postgres" ? "text, integer, boolean, timestamptz, jsonb" : engine === "mysql" ? "varchar(255), int, tinyint(1), datetime, json" : "TEXT, INTEGER, REAL, BLOB"}.`);
  return t;
}

/** Render a DEFAULT literal safely: numbers / booleans as-is (per engine), everything else as a quoted string. */
export function defaultLiteral(engine: Engine, v: string | number | boolean | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return engine === "postgres" ? String(v) : v ? "1" : "0";
  const s = String(v);
  if (/^(current_timestamp|now\(\)|current_date|current_time|null|true|false)$/i.test(s)) return engine === "sqlite" && /^now\(\)$/i.test(s) ? "CURRENT_TIMESTAMP" : s.toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function findTable(tables: TableFact[], name: string): TableFact | undefined {
  const n = String(name ?? "").toLowerCase();
  return tables.find((t) => t.name.toLowerCase() === n) ?? tables.find((t) => t.name.toLowerCase().split(".").pop() === n);
}
/** The ALTER TABLE statement addColumn will run (also used by the UI preview through the API). */
export function addColumnSql(engine: Engine, quote: (n: string) => string, table: string, input: AddColumnInput): string {
  const def = defaultLiteral(engine, input.defaultValue);
  const parts = [`ALTER TABLE ${table.split(".").map(quote).join(".")} ADD COLUMN ${quote(input.column)} ${input.type}`];
  if (!input.nullable) parts.push("NOT NULL");
  if (def !== null) parts.push(`DEFAULT ${def}`);
  return parts.join(" ");
}

async function withWritable<T>(projectId: string, env: string, fn: (pc: Awaited<ReturnType<typeof connForProject>>) => Promise<T>): Promise<T> {
  let pc;
  try { pc = await connForProject(projectId, env, { writable: true }); }
  catch (e) { throw new MutationError(redact((e as Error).message)); }
  try {
    if (pc.schemaOnly) throw new MutationError("This connection is schema only; writes are off for this environment", 403, { schemaOnly: true });
    return await fn(pc);
  } finally { await pc.conn.close().catch(() => undefined); }
}

async function finish(projectId: string, env: string, sourceId: string, what: string, sql: string, ms: number, table?: string): Promise<DdlResult> {
  const activity = await prisma.activity.create({ data: { projectId, env, kind: "write", what: what.slice(0, 200), meta: JSON.stringify({ op: "ddl", table, sql: sql.slice(0, 4000), ms }) } });
  try {
    const s = await syncSource(sourceId);
    return { ok: true, sql, table, ms, activityId: activity.id, snapshot: { id: s.snapshot.id, version: s.snapshot.version, reused: s.reused } };
  } catch (e) {
    return { ok: true, sql, table, ms, activityId: activity.id, snapshot: null, syncError: (e as Error).message };
  }
}

export async function addColumn(projectId: string, env: string, input: AddColumnInput): Promise<DdlResult> {
  const { tables, engine } = await loadSchemaTables(projectId, env);
  if (!tables.length) throw new MutationError("no schema snapshot for this env — connect a database first", 404);
  const t = findTable(tables, input.table);
  if (!t) throw new MutationError(`unknown table "${input.table}" — it is not in the ${env} schema snapshot`);
  const column = String(input.column ?? "").trim();
  if (!IDENT_RE.test(column)) throw new MutationError(`"${column}" is not a valid column name (letters, digits and _ only)`);
  if (t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase())) throw new MutationError(`${t.name} already has a column named ${column}`);
  if (isSecretColumn(column)) throw new MutationError(`"${column}" looks like a secret column; Arkus never creates or writes secrets.`);
  const eng = (engine ?? "postgres") as Engine;
  const type = checkColumnType(eng, input.type);
  if (!input.nullable && defaultLiteral(eng, input.defaultValue) === null && (t.rowEstimate ?? 1) > 0) throw new MutationError(`A NOT NULL column on a table with rows needs a default value`);
  return withWritable(projectId, env, async (pc) => {
    const sql = addColumnSql(pc.conn.engine, pc.conn.quoteId, t.name, { ...input, column, type });
    let res;
    try { res = await pc.conn.query(sql); } catch (e) { throw new MutationError(redact((e as Error).message, pc.config.url)); }
    return finish(projectId, env, pc.sourceId, `Added column ${t.name}.${column} (${type}${input.nullable ? "" : ", not null"})`, sql, res.ms, t.name);
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
  if (!c.ok) throw new MutationError(c.reason);
  const { tables } = await loadSchemaTables(projectId, env);
  if (!tables.length) throw new MutationError("no schema snapshot for this env — connect a database first", 404);
  // ALTER TABLE must name a table the snapshot knows; CREATE TABLE must not clash with one.
  const alter = /^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w".`]+)/i.exec(c.sql);
  const create = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".`]+)/i.exec(c.sql);
  const bare = (n: string) => n.replace(/["`]/g, "").split(".").pop()!.toLowerCase();
  if (alter && !findTable(tables, bare(alter[1]))) throw new MutationError(`unknown table "${bare(alter[1])}" — it is not in the ${env} schema snapshot`);
  if (create && findTable(tables, bare(create[1])) && !/if\s+not\s+exists/i.test(c.sql)) throw new MutationError(`table "${bare(create[1])}" already exists`);
  const table = alter ? findTable(tables, bare(alter[1]))?.name : create ? bare(create[1]) : undefined;
  return withWritable(projectId, env, async (pc) => {
    let res;
    try { res = await pc.conn.query(c.sql); } catch (e) { throw new MutationError(redact((e as Error).message, pc.config.url)); }
    return finish(projectId, env, pc.sourceId, `Ran DDL: ${c.sql.slice(0, 150)}`, c.sql, res.ms, table);
  });
}
