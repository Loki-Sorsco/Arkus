// Row-level writes to the user's database: update one cell (or several columns), insert a row,
// delete a row. Every identifier is validated against the stored schema snapshot for the env and
// quoted per engine; every value is a bound parameter. Update / delete target exactly one row by a
// primary key (or a unique column) and verify rowCount === 1. Secret-like columns are never written.
// Each successful write leaves an Activity record (kind "write") with before / after values of
// non-secret columns so an edit can be undone.
import { prisma } from "@/lib/db";
import { connForProject, redact, type DbConn, type QueryResult } from "./dbconn";
import { loadSchemaTables } from "./schemastore";
import { isSecretColumn, maskRow } from "./browse";
import type { ColumnFact, TableFact } from "./types";

export type PkRef = { name: string; value: unknown };
export type Mutation =
  | { op: "update"; table: string; pk: PkRef; set: Record<string, unknown>; guard?: Record<string, unknown> }
  | { op: "insert"; table: string; values: Record<string, unknown> }
  | { op: "delete"; table: string; pk: PkRef };

export interface MutationResult {
  ok: true;
  op: Mutation["op"];
  table: string;
  sql: string;
  rowCount: number;
  ms: number;
  pk?: PkRef;
  /** Fresh copy of the touched row (update / insert), masked like the browser. */
  row?: Record<string, unknown>;
  activityId?: string;
}

export class MutationError extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

const NO_PK = "This table has no primary key, so Arkus can't target a single row safely";
/** Secret check that also catches camelCase names (passwordHash, apiKey, refreshToken) which the snake_case regex misses. */
const isSecret = (name: string) => isSecretColumn(name) || isSecretColumn(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

// ---------------------------------------------------------------- schema helpers

function findTable(tables: TableFact[], name: string): TableFact | undefined {
  const n = String(name ?? "").toLowerCase();
  return tables.find(t => t.name.toLowerCase() === n) ?? tables.find(t => t.name.toLowerCase().split(".").pop() === n);
}
function findColumn(t: TableFact, name: string): ColumnFact | undefined {
  const n = String(name ?? "").toLowerCase();
  return t.columns.find(c => c.name.toLowerCase() === n);
}
function quoteTable(conn: DbConn, name: string): string {
  return name.split(".").map(p => conn.quoteId(p)).join(".");
}
/** Columns that may target a single row: real pk columns, then single-column unique columns / indexes. */
export function keyColumns(t: TableFact): ColumnFact[] {
  const pks = t.columns.filter(c => c.pk);
  if (pks.length) return pks;
  const uniqueIdx = new Set((t.indexes ?? []).filter(i => i.unique && i.columns.length === 1).map(i => i.columns[0].toLowerCase()));
  return t.columns.filter(c => c.unique || uniqueIdx.has(c.name.toLowerCase()));
}
function resolveKey(t: TableFact, pk: PkRef | undefined): ColumnFact {
  const keys = keyColumns(t);
  if (!keys.length) throw new MutationError(NO_PK);
  if (!pk || typeof pk !== "object" || typeof pk.name !== "string") throw new MutationError(`pk { name, value } is required (use ${keys[0].name})`);
  const col = keys.find(c => c.name.toLowerCase() === pk.name.toLowerCase());
  if (!col) throw new MutationError(`"${pk.name}" is not a primary key or unique column of ${t.name}; use ${keys.map(k => k.name).join(" / ")}`);
  if (pk.value === null || pk.value === undefined || pk.value === "") throw new MutationError(`pk value for ${col.name} is required`);
  return col;
}

// ---------------------------------------------------------------- value coercion

const NUM_RE = /\b(?:big|small|tiny|medium)?int(?:eger)?\d*\b|serial|numeric|decimal|float|double|real|number|money/i;
const BOOL_RE = /\bbool/i;
const TEXT_RE = /char|text|string|clob|uuid|enum|json|xml|citext|blob|bytea|binary/i;

/** Coerce a client value (usually a string from an <input>) into something the driver can bind for this column. */
export function coerceValue(value: unknown, col: ColumnFact): unknown {
  if (value === null || value === undefined) return null;
  const t = (col.type || "").toLowerCase();
  const isBool = BOOL_RE.test(t), isNum = !isBool && NUM_RE.test(t), isText = TEXT_RE.test(t);
  if (typeof value === "string") {
    if (value === "" && !isText && col.nullable !== false) return null;
    if (isBool) {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "t" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "f" || v === "no") return false;
      if (v === "" || v === "null") return null;
      throw new MutationError(`"${col.name}" expects true or false`);
    }
    if (isNum) {
      const v = value.trim();
      if (v === "") return null;
      const n = Number(v);
      if (Number.isNaN(n)) throw new MutationError(`"${col.name}" expects a number (${col.type})`);
      return n;
    }
    return value;
  }
  if (typeof value === "boolean") return isNum ? (value ? 1 : 0) : value;
  if (typeof value === "number" || typeof value === "bigint") return isBool ? Boolean(value) : value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** Values the driver returns from sqlite / mysql for booleans are 0/1; for comparisons that is what we want. */
function bindFor(conn: DbConn, v: unknown): unknown {
  if (typeof v === "boolean" && conn.engine !== "postgres") return v ? 1 : 0;
  return v;
}

// ---------------------------------------------------------------- core

type Prepared = { sql: string; params: unknown[] };

function prepareUpdate(conn: DbConn, t: TableFact, key: ColumnFact, keyValue: unknown, set: Record<string, unknown>, guard?: Record<string, unknown>): { prepared: Prepared; columns: string[]; after: Record<string, unknown>; before: Record<string, unknown> | undefined } {
  const entries = Object.entries(set ?? {});
  if (!entries.length) throw new MutationError("set must contain at least one column");
  const params: unknown[] = [];
  const assigns: string[] = [];
  const after: Record<string, unknown> = {};
  for (const [name, raw] of entries) {
    const col = findColumn(t, name);
    if (!col) throw new MutationError(`unknown column "${name}" on ${t.name}`);
    if (isSecret(col.name)) throw new MutationError(`"${col.name}" is a secret-like column; Arkus never writes secrets. Change it from your app instead.`);
    if (col.name.toLowerCase() === key.name.toLowerCase()) throw new MutationError(`Primary keys aren't edited in place (${col.name}). Insert a new row instead.`);
    const v = coerceValue(raw, col);
    after[col.name] = v;
    params.push(bindFor(conn, v));
    assigns.push(`${conn.quoteId(col.name)} = ${conn.param(params.length)}`);
  }
  params.push(bindFor(conn, keyValue));
  const where: string[] = [`${conn.quoteId(key.name)} = ${conn.param(params.length)}`];
  let before: Record<string, unknown> | undefined;
  if (guard && typeof guard === "object") {
    before = {};
    for (const [name, raw] of Object.entries(guard)) {
      const col = findColumn(t, name);
      if (!col) throw new MutationError(`unknown guard column "${name}" on ${t.name}`);
      if (isSecret(col.name)) throw new MutationError(`"${col.name}" is a secret-like column and can't be used as a guard`);
      const v = coerceValue(raw, col);
      before[col.name] = v;
      if (v === null) { where.push(`${conn.quoteId(col.name)} IS NULL`); continue; }
      params.push(bindFor(conn, v));
      where.push(`${conn.quoteId(col.name)} = ${conn.param(params.length)}`);
    }
  }
  const sql = `UPDATE ${quoteTable(conn, t.name)} SET ${assigns.join(", ")} WHERE ${where.join(" AND ")}`;
  return { prepared: { sql, params }, columns: Object.keys(after), after, before };
}

function prepareInsert(conn: DbConn, t: TableFact, values: Record<string, unknown>): { prepared: Prepared; columns: string[]; after: Record<string, unknown> } {
  const entries = Object.entries(values ?? {});
  if (!entries.length) throw new MutationError("values must contain at least one column");
  const params: unknown[] = [];
  const names: string[] = [];
  const after: Record<string, unknown> = {};
  for (const [name, raw] of entries) {
    const col = findColumn(t, name);
    if (!col) throw new MutationError(`unknown column "${name}" on ${t.name}`);
    if (isSecret(col.name)) throw new MutationError(`"${col.name}" is a secret-like column; Arkus never writes secrets. Leave it out and set it from your app.`);
    const v = coerceValue(raw, col);
    after[col.name] = v;
    params.push(bindFor(conn, v));
    names.push(conn.quoteId(col.name));
  }
  const placeholders = params.map((_, i) => conn.param(i + 1)).join(", ");
  let sql = `INSERT INTO ${quoteTable(conn, t.name)} (${names.join(", ")}) VALUES (${placeholders})`;
  const keys = keyColumns(t);
  if (conn.engine === "postgres" && keys.length) sql += ` RETURNING ${keys.map(k => conn.quoteId(k.name)).join(", ")}`;
  return { prepared: { sql, params }, columns: Object.keys(after), after };
}

function prepareDelete(conn: DbConn, t: TableFact, key: ColumnFact, keyValue: unknown): Prepared {
  return { sql: `DELETE FROM ${quoteTable(conn, t.name)} WHERE ${conn.quoteId(key.name)} = ${conn.param(1)}`, params: [bindFor(conn, keyValue)] };
}

async function readRow(conn: DbConn, t: TableFact, key: ColumnFact, keyValue: unknown): Promise<Record<string, unknown> | undefined> {
  const visible = t.columns.filter(c => !isSecret(c.name));
  const list = visible.length ? visible.map(c => conn.quoteId(c.name)).join(", ") : "*";
  const res = await conn.query(`SELECT ${list} FROM ${quoteTable(conn, t.name)} WHERE ${conn.quoteId(key.name)} = ${conn.param(1)} LIMIT 1`, [bindFor(conn, keyValue)]);
  const row = res.rows[0];
  return row ? maskRow(row) : undefined;
}

/** Render a parameterized statement with its values inlined, for toasts / activity only (never executed). */
export function renderSql(conn: Pick<DbConn, "engine">, sql: string, params: unknown[]): string {
  const lit = (v: unknown) => v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : typeof v === "boolean" ? (conn.engine === "postgres" ? String(v) : v ? "1" : "0") : `'${String(v).replace(/'/g, "''")}'`;
  if (conn.engine === "postgres") return sql.replace(/\$(\d+)/g, (_, i) => lit(params[Number(i) - 1]));
  let i = 0;
  return sql.replace(/\?/g, () => lit(params[i++]));
}

export async function applyMutation(projectId: string, env: string, m: Mutation): Promise<MutationResult> {
  if (!m || typeof m !== "object" || !["update", "insert", "delete"].includes((m as Mutation).op)) throw new MutationError("mutation.op must be update, insert or delete");
  if (typeof m.table !== "string" || !m.table.trim()) throw new MutationError("mutation.table is required");
  const { tables } = await loadSchemaTables(projectId, env);
  if (!tables.length) throw new MutationError("no schema snapshot for this env — connect a database first", 404);
  const t = findTable(tables, m.table);
  if (!t) throw new MutationError(`unknown table "${m.table}" — it is not in the ${env} schema snapshot`);

  let pc;
  try { pc = await connForProject(projectId, env, { writable: true }); }
  catch (e) { throw new MutationError(redact((e as Error).message)); }
  const { conn } = pc;
  try {
    if (pc.schemaOnly) throw new MutationError("This connection is schema only; writes are off for this environment", 403, { schemaOnly: true });

    let prepared: Prepared;
    let what: string;
    let meta: Record<string, unknown>;
    let key: ColumnFact | undefined;
    let keyValue: unknown;
    let pk: PkRef | undefined;

    if (m.op === "update") {
      key = resolveKey(t, m.pk);
      keyValue = coerceValue(m.pk.value, key);
      const p = prepareUpdate(conn, t, key, keyValue, m.set, m.guard);
      prepared = p.prepared;
      pk = { name: key.name, value: keyValue };
      what = `Updated ${t.name}.${p.columns.join(", ")} (${key.name} = ${String(keyValue)})`;
      meta = { table: t.name, op: m.op, pk, columns: p.columns, before: p.before, after: p.after };
    } else if (m.op === "insert") {
      const p = prepareInsert(conn, t, m.values);
      prepared = p.prepared;
      const keys = keyColumns(t);
      key = keys[0];
      if (key && p.after[key.name] !== undefined && p.after[key.name] !== null) { keyValue = p.after[key.name]; pk = { name: key.name, value: keyValue }; }
      what = `Inserted a row into ${t.name}`;
      meta = { table: t.name, op: m.op, pk, columns: p.columns, after: p.after };
    } else {
      key = resolveKey(t, m.pk);
      keyValue = coerceValue(m.pk.value, key);
      prepared = prepareDelete(conn, t, key, keyValue);
      pk = { name: key.name, value: keyValue };
      what = `Deleted ${t.name} where ${key.name} = ${String(keyValue)}`;
      const before = await readRow(conn, t, key, keyValue);
      if (!before) throw new MutationError("No row matched (it may have changed since you loaded it)", 409);
      meta = { table: t.name, op: m.op, pk, columns: Object.keys(before), before };
    }

    let res: QueryResult;
    try { res = await conn.query(prepared.sql, prepared.params); }
    catch (e) { throw new MutationError(redact((e as Error).message, pc.config.url)); }
    const rowCount = res.rowCount ?? 0;
    if (m.op !== "insert" && rowCount !== 1) {
      if (rowCount === 0) throw new MutationError("No row matched (it may have changed since you loaded it)", 409);
      // >1 can only happen on a non-unique "unique" column; the statement already ran, so report it loudly.
      throw new MutationError(`${rowCount} rows were affected; expected exactly one. Check that ${key!.name} is unique.`, 500);
    }
    if (m.op === "insert" && rowCount !== 1) throw new MutationError(`insert affected ${rowCount} rows`, 500);

    // Figure out the key of a freshly inserted row when the database generated it.
    if (m.op === "insert" && key && pk === undefined) {
      const returned = res.rows[0]?.[key.name];
      if (returned !== undefined && returned !== null) pk = { name: key.name, value: returned };
      else if (res.lastInsertId !== undefined && NUM_RE.test(key.type || "")) pk = { name: key.name, value: res.lastInsertId };
      if (pk) { keyValue = pk.value; meta.pk = pk; }
    }
    const row = m.op !== "delete" && key && pk ? await readRow(conn, t, key, keyValue).catch(() => undefined) : undefined;
    const sql = renderSql(conn, prepared.sql, prepared.params);
    const activity = await prisma.activity.create({ data: { projectId, env, kind: "write", what: what.slice(0, 200), meta: JSON.stringify({ ...meta, sql: sql.slice(0, 4000), ms: res.ms }) } });
    return { ok: true, op: m.op, table: t.name, sql, rowCount, ms: res.ms, pk, row, activityId: activity.id };
  } finally {
    await conn.close().catch(() => undefined);
  }
}
