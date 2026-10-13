// Staged edits for the data grid (Beekeeper model): cell edits, row deletes and new rows accumulate in
// a `Pending` value until Apply turns them into ordered mutations (updates with optimistic guards, then
// deletes, then inserts) and runs them one by one, stopping at the first failure. Pure functions, no React,
// so the whole flow is testable without the grid. A module-level store keeps pending edits alive while a
// table tab is unmounted (inactive tabs unmount) and until the user applies or discards them.
import { param, quoteId, type DbColumn, type Row } from "./db-shared";

export type PkRef = { name: string; value: unknown };
export type Mutation =
  | { op: "update"; table: string; pk: PkRef; set: Record<string, unknown>; guard?: Record<string, unknown> }
  | { op: "insert"; table: string; values: Record<string, unknown> }
  | { op: "delete"; table: string; pk: PkRef };
export type MutateResp = { ok?: boolean; error?: string; sql?: string; rowCount?: number; row?: Row; pk?: PkRef; schemaOnly?: boolean; status?: number };

export type PendingUpdate = { pk: unknown; col: string; from: unknown; to: unknown };
export type PendingInsert = { id: string; values: Record<string, string> };
export type Pending = { updates: Record<string, PendingUpdate>; deletes: Record<string, unknown>; inserts: PendingInsert[] };
/** One mutation plus the pending keys it settles, so a partial Apply can drop exactly what succeeded. */
export type Staged = { mutation: Mutation; keys: string[]; label: string };

// ---------- value helpers ----------
export const isBoolType = (c?: DbColumn) => !!c && /bool/i.test(c.type || "");
export const isNumType = (c?: DbColumn) => !!c && /\b(?:big|small|tiny|medium)?int(?:eger)?\d*\b|serial|numeric|decimal|float|double|real|number|money/i.test(c.type || "");
/** "Will the database fill this key itself?" — serial / identity / uuid-ish types or any default. */
export const isAutoKey = (c: DbColumn) => !!c.default || /serial|auto|identity|cuid|uuid/i.test(c.type || "");
export const rawText = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
export const same = (a: unknown, b: unknown) => (a == null && b == null) || (a != null && b != null && rawText(a) === rawText(b));
/** Columns a new row can take values for: not secret, and not an auto-generated key. */
export const insertable = (c: DbColumn, secret: (name: string) => boolean) => !c.secret && !secret(c.name) && !(c.pk && isAutoKey(c));
export const requiredOnInsert = (c: DbColumn) => c.nullable === false && !c.default && !(c.pk && isAutoKey(c));

// ---------- pending model ----------
export const emptyPending = (): Pending => ({ updates: {}, deletes: {}, inserts: [] });
export const pkKey = (pk: unknown) => rawText(pk);
export const updateKey = (pk: unknown, col: string) => `u:${pkKey(pk)}\u0000${col}`;
export const deleteKey = (pk: unknown) => `d:${pkKey(pk)}`;
export const insertKey = (id: string) => `i:${id}`;
export const pendingCount = (p: Pending) => Object.keys(p.updates).length + Object.keys(p.deletes).length + p.inserts.length;
export const isDeleted = (p: Pending, pk: unknown) => deleteKey(pk) in p.deletes;

/** Stage a cell change against the value the database currently holds; staging the original value again un-stages it. */
export function stageUpdate(p: Pending, pk: unknown, col: string, from: unknown, to: unknown): Pending {
  const k = updateKey(pk, col);
  const updates = { ...p.updates };
  if (same(from, to)) delete updates[k]; else updates[k] = { pk, col, from, to };
  return { ...p, updates };
}
export function toggleDelete(p: Pending, pk: unknown): Pending {
  const k = deleteKey(pk);
  const deletes = { ...p.deletes };
  if (k in deletes) delete deletes[k]; else deletes[k] = pk;
  return { ...p, deletes };
}
export const addInsert = (p: Pending, id: string, values: Record<string, string> = {}): Pending => ({ ...p, inserts: [{ id, values }, ...p.inserts] });
export const setInsertValue = (p: Pending, id: string, col: string, v: string): Pending => ({ ...p, inserts: p.inserts.map((i) => (i.id === id ? { ...i, values: { ...i.values, [col]: v } } : i)) });
export const removeInsert = (p: Pending, id: string): Pending => ({ ...p, inserts: p.inserts.filter((i) => i.id !== id) });
/** Pending updates folded per row (pk key → column → new value) so the grid can overlay them on fetched rows. */
export function overlayByPk(p: Pending): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const u of Object.values(p.updates)) (out[pkKey(u.pk)] ??= {})[u.col] = u.to;
  return out;
}

/** Required columns a staged insert leaves blank, per insert (empty when every new row is complete). */
export function insertProblems(p: Pending, columns: DbColumn[], secret: (name: string) => boolean): string[] {
  const out: string[] = [];
  p.inserts.forEach((ins, i) => {
    const missing = columns.filter((c) => insertable(c, secret) && requiredOnInsert(c) && !(ins.values[c.name] ?? "").trim()).map((c) => c.name);
    if (missing.length) out.push(`new row ${i + 1}: ${missing.join(", ")} required`);
  });
  return out;
}

/** Order: updates (one statement per row, guarded by the original values), then deletes, then inserts.
 * Updates on rows that are also marked for deletion are skipped (the delete wins). */
export function buildMutations(p: Pending, table: string, keyCol: string): Staged[] {
  const out: Staged[] = [];
  const rows = new Map<string, { pk: unknown; keys: string[]; set: Record<string, unknown>; guard: Record<string, unknown> }>();
  for (const [k, u] of Object.entries(p.updates)) {
    if (isDeleted(p, u.pk)) continue;
    const pk = pkKey(u.pk);
    const row = rows.get(pk) ?? { pk: u.pk, keys: [], set: {}, guard: {} };
    row.keys.push(k); row.set[u.col] = u.to; row.guard[u.col] = u.from;
    rows.set(pk, row);
  }
  for (const r of rows.values()) out.push({ mutation: { op: "update", table, pk: { name: keyCol, value: r.pk }, set: r.set, guard: r.guard }, keys: r.keys, label: `update ${keyCol} = ${pkKey(r.pk)} (${Object.keys(r.set).join(", ")})` });
  for (const [k, pk] of Object.entries(p.deletes)) out.push({ mutation: { op: "delete", table, pk: { name: keyCol, value: pk } }, keys: [k], label: `delete ${keyCol} = ${pkKey(pk)}` });
  for (const ins of p.inserts) {
    const values: Record<string, unknown> = {};
    for (const [c, v] of Object.entries(ins.values)) if (v !== undefined && v !== "") values[c] = v;
    out.push({ mutation: { op: "insert", table, values }, keys: [insertKey(ins.id)], label: `insert (${Object.keys(values).join(", ") || "defaults only"})` });
  }
  return out;
}

/** Drop the pending entries a successful Apply settled (updates and deletes that were also staged for a deleted row go too). */
export function removeStaged(p: Pending, keys: string[]): Pending {
  const gone = new Set(keys);
  const updates: Pending["updates"] = {};
  for (const [k, u] of Object.entries(p.updates)) if (!gone.has(k) && !gone.has(deleteKey(u.pk))) updates[k] = u;
  const deletes: Pending["deletes"] = {};
  for (const [k, v] of Object.entries(p.deletes)) if (!gone.has(k)) deletes[k] = v;
  return { updates, deletes, inserts: p.inserts.filter((i) => !gone.has(insertKey(i.id))) };
}

// ---------- SQL preview ----------
const lit = (v: unknown): string => v == null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${rawText(v).replace(/'/g, "''")}'`;
/** What the server will run, as a parameterized statement plus its bindings (the server binds every value; this never concatenates them). */
export function previewSql(m: Mutation, engine: string | null | undefined): string {
  const q = (n: string) => quoteId(engine, n);
  const binds: unknown[] = [];
  const p = (v: unknown) => { binds.push(v); return param(engine, binds.length); };
  let sql: string;
  if (m.op === "update") {
    const set = Object.entries(m.set).map(([c, v]) => `${q(c)} = ${p(v)}`).join(", ");
    const where = [`${q(m.pk.name)} = ${p(m.pk.value)}`, ...Object.entries(m.guard || {}).map(([c, v]) => (v == null ? `${q(c)} IS NULL` : `${q(c)} = ${p(v)}`))];
    sql = `UPDATE ${q(m.table)} SET ${set} WHERE ${where.join(" AND ")}`;
  } else if (m.op === "insert") {
    const cols = Object.keys(m.values);
    sql = cols.length ? `INSERT INTO ${q(m.table)} (${cols.map(q).join(", ")}) VALUES (${cols.map((c) => p(m.values[c])).join(", ")})` : `INSERT INTO ${q(m.table)} DEFAULT VALUES`;
  } else sql = `DELETE FROM ${q(m.table)} WHERE ${q(m.pk.name)} = ${p(m.pk.value)}`;
  return binds.length ? `${sql};  -- ${binds.map(lit).join(", ")}` : `${sql};`;
}

// ---------- apply ----------
export type ApplyResult = { applied: string[]; done: number; failed?: { index: number; error: string; sql: string } };
/** Run staged mutations in order through `run`; stop at the first failure and report which keys settled. */
export async function applyStaged(items: Staged[], run: (m: Mutation) => Promise<MutateResp>, engine: string | null | undefined): Promise<ApplyResult> {
  const applied: string[] = [];
  for (let i = 0; i < items.length; i++) {
    let res: MutateResp;
    try { res = await run(items[i].mutation); } catch (e) { res = { ok: false, error: (e as Error).message }; }
    if (!res.ok) return { applied, done: i, failed: { index: i, error: res.error || `the database refused the ${items[i].mutation.op}`, sql: res.sql || previewSql(items[i].mutation, engine) } };
    applied.push(...items[i].keys);
  }
  return { applied, done: items.length };
}

// ---------- store (survives tab switches; cleared on apply / discard) ----------
const store = new Map<string, Pending>();
export const pendingStore = {
  key: (slug: string, env: string, table: string) => `${slug}|${env}|${table}`,
  get: (k: string): Pending => store.get(k) ?? emptyPending(),
  set: (k: string, p: Pending) => { if (pendingCount(p)) store.set(k, p); else store.delete(k); },
};
