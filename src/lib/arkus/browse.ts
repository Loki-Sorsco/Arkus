// Data browser: parameterized SELECTs only. Identifiers are validated against the introspected
// schema (never interpolated from user input) and quoted per engine. PII-looking columns are
// masked; secret-like columns are never selected at all.
import type { TableFact } from "./types";
import type { DbConn } from "./dbconn";

export type FilterOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "like" | "is null" | "not null";
export interface BrowseFilter { column: string; op: FilterOp; value?: unknown }
export interface BrowseOpts {
  page?: number;
  pageSize?: number;                      // ≤ 200
  sort?: { column: string; dir?: "asc" | "desc" };
  filters?: BrowseFilter[];
}
export interface BrowseResult {
  table: string;
  columns: string[];                      // columns actually returned (secret columns omitted)
  hidden: string[];                       // secret columns withheld
  masked: string[];                       // columns whose values are masked
  rows: Record<string, unknown>[];
  page: number;
  pageSize: number;
  total: number;                          // estimate (or exact when `totalExact`)
  totalExact: boolean;
  ms: number;
}

export const MAX_PAGE_SIZE = 200;
const OPS: Record<FilterOp, string> = { "=": "=", "!=": "<>", ">": ">", "<": "<", ">=": ">=", "<=": "<=", like: "LIKE", "is null": "IS NULL", "not null": "IS NOT NULL" };

// ---------------------------------------------------------------- masking

const SECRET_RE = /(^|_)(password|passwd|pwd|token|secret|hash|api_?key|private_?key|access_?key|refresh_?token|salt|otp)(_|$)/i;
const EMAIL_RE = /(^|_)e?mail(_|$)/i;
const PII_RE = /(^|_)(phone|mobile|tel|telephone|ssn|social_?security|card|credit_?card|cc_?number|pan|iban|account_?number|passport|license|tax_?id|dob|birth_?date)(_|$)/i;

// camelCase names (passwordHash, apiKey, refreshToken) are normalised to snake_case before matching.
const norm = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
export const isSecretColumn = (name: string) => SECRET_RE.test(name) || SECRET_RE.test(norm(name));
export const isPiiColumn = (name: string) => isSecretColumn(name) || [name, norm(name)].some((n) => EMAIL_RE.test(n) || PII_RE.test(n));

export function maskValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isSecretColumn(column)) return "••••";
  if (EMAIL_RE.test(column)) {
    const s = String(value);
    const at = s.indexOf("@");
    if (at <= 0) return "••••";
    return `${s[0]}***@${s.slice(at + 1)}`;
  }
  if (PII_RE.test(column)) {
    const s = String(value);
    return s.length > 4 ? `••••${s.slice(-2)}` : "••••";
  }
  return value;
}

/** Mask PII-looking columns; drop secret-like columns entirely. */
export function maskRow(row: Record<string, unknown>, columns?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of columns ?? Object.keys(row)) {
    if (isSecretColumn(k)) continue;
    out[k] = maskValue(k, row[k]);
  }
  return out;
}
export function maskRows(rows: Record<string, unknown>[], fields: string[]) {
  const visible = fields.filter(f => !isSecretColumn(f));
  return { columns: visible, hidden: fields.filter(f => isSecretColumn(f)), masked: visible.filter(isPiiColumn), rows: rows.map(r => maskRow(r, visible)) };
}

// ---------------------------------------------------------------- browse

function findTable(tables: TableFact[], name: string): TableFact | undefined {
  const n = name.toLowerCase();
  return tables.find(t => t.name.toLowerCase() === n) ?? tables.find(t => t.name.toLowerCase().split(".").pop() === n);
}
function quoteTable(conn: DbConn, name: string): string {
  return name.split(".").map(p => conn.quoteId(p)).join(".");
}

export async function browseRows(conn: DbConn, tables: TableFact[], table: string, opts: BrowseOpts = {}): Promise<BrowseResult> {
  const t = findTable(tables, table);
  if (!t) throw new Error(`unknown table "${table}"`);
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(opts.pageSize) || 50)));
  const colOf = (name: string) => {
    const c = t.columns.find(x => x.name.toLowerCase() === String(name).toLowerCase());
    if (!c) throw new Error(`unknown column "${name}" on ${t.name}`);
    return c;
  };
  const visible = t.columns.filter(c => !isSecretColumn(c.name));
  const hidden = t.columns.filter(c => isSecretColumn(c.name)).map(c => c.name);
  const selectList = visible.length ? visible.map(c => conn.quoteId(c.name)).join(", ") : "*";

  const params: unknown[] = [];
  const where: string[] = [];
  for (const f of opts.filters ?? []) {
    const c = colOf(f.column);
    if (isSecretColumn(c.name)) throw new Error(`cannot filter on secret column "${c.name}"`);
    const op = OPS[f.op];
    if (!op) throw new Error(`unknown filter op "${f.op}"`);
    const qc = conn.quoteId(c.name);
    if (f.op === "is null" || f.op === "not null") { where.push(`${qc} ${op}`); continue; }
    params.push(coerce(f.value, c.type));
    where.push(`${qc} ${op} ${conn.param(params.length)}`);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  let orderSql = "";
  if (opts.sort?.column) {
    const c = colOf(opts.sort.column);
    orderSql = ` ORDER BY ${conn.quoteId(c.name)} ${opts.sort.dir === "desc" ? "DESC" : "ASC"}`;
  } else {
    const pk = t.columns.find(c => c.pk);
    if (pk) orderSql = ` ORDER BY ${conn.quoteId(pk.name)} ASC`;
  }
  params.push(pageSize, (page - 1) * pageSize);
  const sql = `SELECT ${selectList} FROM ${quoteTable(conn, t.name)}${whereSql}${orderSql} LIMIT ${conn.param(params.length - 1)} OFFSET ${conn.param(params.length)}`;
  const res = await conn.query(sql, params);

  let total = t.rowEstimate ?? 0;
  let totalExact = false;
  if (where.length) {
    if ((t.rowEstimate ?? 0) <= 200_000) {
      const cnt = await conn.query(`SELECT count(*) AS n FROM ${quoteTable(conn, t.name)}${whereSql}`, params.slice(0, -2));
      total = Number(cnt.rows[0]?.n ?? 0); totalExact = true;
    }
  } else if (res.rows.length < pageSize) {
    total = (page - 1) * pageSize + res.rows.length; totalExact = true;
  }
  const masked = maskRows(res.rows, res.fields.length ? res.fields : visible.map(c => c.name));
  return { table: t.name, columns: masked.columns, hidden, masked: masked.masked, rows: masked.rows, page, pageSize, total, totalExact, ms: res.ms };
}

/** Coerce a filter value from the query string into something the driver can bind. */
function coerce(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  const t = type.toLowerCase();
  if (typeof value === "string") {
    if (/int|serial|numeric|decimal|float|double|real|number/.test(t) && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
    if (/bool/.test(t)) return value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value;
  }
  return value;
}
