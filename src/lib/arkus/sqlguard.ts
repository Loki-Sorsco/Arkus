// Read guard for user / LLM supplied SQL. Defense in depth: lexical checks first (one statement,
// no comments, no write / dangerous keywords even inside strings, ASCII-only code), then
// node-sql-parser per dialect to confirm it is a SELECT and to list every referenced table,
// then an allow-list check. When the parser fails on every dialect a conservative regex
// fallback is used that REJECTS unless it is confident. Finally LIMIT is capped at 1000.
import { Parser, type AST, type Option } from "node-sql-parser";

export const MAX_LIMIT = 1000;
export type GuardOpts = { engine?: "postgres" | "mysql" | "sqlite"; maxLimit?: number };
export type GuardResult = { ok: true; sql: string; tables: string[]; limit: number } | { ok: false; reason: string };

// Statement keywords that must never appear in a read query (whole words, case-insensitive, outside
// string literals and quoted identifiers). Column names like user_id are fine (underscore is a word char).
const KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke", "copy", "call", "exec", "execute",
  "merge", "upsert", "into", "outfile", "dumpfile", "load", "returning", "lock", "unlock", "set", "show", "use", "attach", "detach",
  "vacuum", "pragma", "reindex", "analyze", "analyse", "do", "listen", "notify", "prepare", "deallocate", "declare", "cursor",
  "begin", "commit", "rollback", "savepoint", "install", "uninstall", "shutdown", "kill", "user", "current_user", "session_user",
  "xp_cmdshell", "sp_executesql", "dblink", "information_schema", "pg_catalog", "sqlite_master", "sqlite_temp_master", "mysql", "performance_schema", "sys",
];
const KEYWORD_RE = new RegExp(`(?<![\\w$.])(?:${KEYWORDS.join("|")})(?![\\w$])`, "i");
// Dangerous functions: matched only when called (name followed by "("). Prefix families cover
// pg_* (pg_sleep, pg_read_file, pg_ls_dir, pg_terminate_backend …), lo_* (large objects), dblink*, sys_*, xp_*, sp_*.
const FUNC_RE = /(?<![\w$])(?:pg_\w*|lo_\w*|dblink\w*|sys_\w*|xp_\w*|sp_\w*|fts\w*|load_?\w*|read\w*|write\w*|sleep|benchmark|version|edit|zipfile|sqlar\w*|query_to_xml\w*|xmlparse|txid_\w*|nextval|setval|currval|lastval|set_config|current_setting|get_lock|release_lock|is_used_lock|master_pos_wait|load_extension|fts3_tokenizer|sqlite_compileoption_\w*|sqlite_source_id|randomblob|inet_server_\w*|inet_client_\w*|current_schemas?|dbms_\w*|utl_\w*)\s*\(/i;
// `FOR UPDATE` / `FOR SHARE` / `FOR NO KEY UPDATE` / `FOR KEY SHARE` lock rows — never allowed.
const FOR_LOCK_RE = /\bfor\s+(?:no\s+key\s+)?(?:update|share|key\s+share)\b/i;

/** Replace the bodies of single-quoted strings with '' (SQL-standard '' doubling only). */
function stripStringsStd(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}
/** Same, but honouring backslash escapes (MySQL / sqlite with escapes). */
function stripStringsBackslash(s: string): string {
  return s.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}
/** Strip double-quoted / backticked identifiers so their contents are not keyword-checked. */
function stripIdents(s: string): string {
  return s.replace(/"(?:[^"]|"")*"/g, '"x"').replace(/`(?:[^`]|``)*`/g, "`x`");
}

const DIALECTS: Record<NonNullable<GuardOpts["engine"]>, string> = { postgres: "postgresql", mysql: "mysql", sqlite: "sqlite" };

function normName(n: string): string {
  return n.replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
}
function allowedSet(allowedTables: string[]): { full: Set<string>; bare: Set<string> } {
  const full = new Set<string>(); const bare = new Set<string>();
  for (const t of allowedTables) {
    const parts = t.split(".").map(normName);
    full.add(parts.join("."));
    bare.add(parts[parts.length - 1]);
  }
  return { full, bare };
}
function tableAllowed(ref: string, allowed: { full: Set<string>; bare: Set<string> }): boolean {
  const parts = ref.split(".").map(normName).filter(Boolean);
  const bare = parts[parts.length - 1];
  if (allowed.full.has(parts.join("."))) return true;
  if (parts.length === 1) return allowed.bare.has(bare);
  // schema-qualified reference: allow when the exact qualified name is allowed, or the schema is
  // "public"/"main"/"dbo" and the bare name is allowed.
  return ["public", "main", "dbo"].includes(parts[0]) && parts.length === 2 && allowed.bare.has(bare);
}

/** Try node-sql-parser on the engine's dialect first, then the others. */
function parseAny(sql: string, engine?: GuardOpts["engine"]): { ast: AST | AST[]; tableList: string[]; dialect: string } | null {
  const parser = new Parser();
  const order = [engine ? DIALECTS[engine] : null, "postgresql", "mysql", "sqlite"].filter((d, i, a): d is string => Boolean(d) && a.indexOf(d) === i);
  for (const database of order) {
    try {
      const r = parser.parse(sql, { database } as Option);
      return { ast: r.ast, tableList: r.tableList, dialect: database };
    } catch { /* try next dialect */ }
  }
  return null;
}

function cteNames(ast: AST | AST[]): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.with)) for (const w of o.with as { name?: { value?: string } | string }[]) {
      const n = typeof w.name === "string" ? w.name : w.name?.value;
      if (n) names.add(normName(n));
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(ast);
  return names;
}

/** Conservative regex table extraction. Returns null when not confident. */
function regexTables(code: string): string[] | null {
  const tables: string[] = [];
  const re = /\b(from|join)\s+([^\s,()]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const ref = m[2];
    if (!/^[\w".`]+$/.test(ref)) return null;
    tables.push(ref);
  }
  // Any FROM/JOIN followed by "(" (subquery / lateral / function) → not confident.
  if (/\b(from|join)\s*\(/i.test(code)) return null;
  if (tables.length === 0 && /\bfrom\b/i.test(code)) return null;
  return tables;
}

/** Cap / append LIMIT. Returns null if a FETCH FIRST clause exceeds the cap. */
function applyLimit(sql: string, max: number): { sql: string; limit: number } | null {
  const s = sql.trim().replace(/;+\s*$/, "").trim();
  const fetch = /\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\s*$/i.exec(s);
  if (fetch) return Number(fetch[1]) > max ? null : { sql: s, limit: Number(fetch[1]) };
  const lim = /\blimit\s+(\d+)(?:\s*,\s*(\d+))?(\s+offset\s+\d+)?\s*$/i.exec(s);
  if (lim) {
    const n = lim[2] !== undefined ? Number(lim[2]) : Number(lim[1]);
    if (n <= max) return { sql: s, limit: n };
    const replaced = lim[2] !== undefined ? `LIMIT ${lim[1]}, ${max}` : `LIMIT ${max}${lim[3] ?? ""}`;
    return { sql: s.slice(0, lim.index) + replaced, limit: max };
  }
  if (/\blimit\s+all\s*$/i.test(s)) return { sql: s.replace(/\blimit\s+all\s*$/i, `LIMIT ${max}`), limit: max };
  return { sql: `${s} LIMIT ${max}`, limit: max };
}

export function guardRead(sql: string, allowedTables: string[], opts: GuardOpts = {}): GuardResult {
  const max = Math.min(opts.maxLimit ?? MAX_LIMIT, MAX_LIMIT);
  if (typeof sql !== "string") return { ok: false, reason: "sql must be a string" };
  let s = sql.normalize("NFKC").trim();
  if (!s) return { ok: false, reason: "empty query" };
  if (s.length > 20000) return { ok: false, reason: "query too long" };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return { ok: false, reason: "control characters are not allowed" };
  s = s.replace(/;+\s*$/, "").trim();
  if (s.includes(";")) return { ok: false, reason: "only one statement is allowed (';' found)" };
  if (/--|\/\*|\*\/|(^|\s)#/.test(s)) return { ok: false, reason: "comments are not allowed" };
  if (/^\(*\s*(select|with)\b/i.test(s) === false) return { ok: false, reason: "only SELECT (or WITH … SELECT) queries are allowed" };

  // Keyword check on the code with strings stripped two ways (standard '' and backslash escapes),
  // so a string can't hide a keyword from us under either dialect's escaping rules.
  for (const code of [stripIdents(stripStringsStd(s)), stripIdents(stripStringsBackslash(s))]) {
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(code)) return { ok: false, reason: "non-ASCII characters are only allowed inside string literals" };
    const kw = KEYWORD_RE.exec(code);
    if (kw) return { ok: false, reason: `forbidden keyword: ${kw[0].toUpperCase()}` };
    const fn = FUNC_RE.exec(code);
    if (fn) return { ok: false, reason: `forbidden function: ${fn[0].replace(/\s*\($/, "").toUpperCase()}()` };
    if (FOR_LOCK_RE.test(code)) return { ok: false, reason: "row locking (FOR UPDATE / FOR SHARE) is not allowed" };
    if (/\$\$|\$[a-z_]*\$/i.test(code)) return { ok: false, reason: "dollar-quoted strings are not allowed" };
    const unions = (code.match(/\bunion\b/gi) ?? []).length;
    const unionSelects = (code.match(/\bunion\s+(?:all\s+|distinct\s+)?\(*\s*select\b/gi) ?? []).length;
    if (unions !== unionSelects) return { ok: false, reason: "UNION must be followed by SELECT" };
    if (/::\s*regclass|::\s*regproc/i.test(code)) return { ok: false, reason: "catalog casts are not allowed" };
  }

  const allowed = allowedSet(allowedTables);
  let tables: string[];
  const parsed = parseAny(s, opts.engine);
  if (parsed) {
    if (Array.isArray(parsed.ast) && parsed.ast.length !== 1) return { ok: false, reason: "only one statement is allowed" };
    const root = Array.isArray(parsed.ast) ? parsed.ast[0] : parsed.ast;
    if (root.type !== "select") return { ok: false, reason: `statement type ${String(root.type).toUpperCase()} is not allowed` };
    const ctes = cteNames(parsed.ast);
    tables = [];
    for (const entry of parsed.tableList) {
      const [op, db, name] = entry.split("::");
      if (op !== "select") return { ok: false, reason: `write operation ${op.toUpperCase()} is not allowed` };
      const ref = db && db !== "null" ? `${db}.${name}` : name;
      if (ctes.has(normName(name)) && (!db || db === "null")) continue;
      tables.push(ref);
    }
  } else {
    const fromRegex = regexTables(stripIdents(stripStringsStd(s)));
    if (!fromRegex) return { ok: false, reason: "could not parse query safely; simplify it (no subqueries in FROM, plain table names)" };
    tables = fromRegex;
  }
  for (const t of tables) {
    if (!tableAllowed(t, allowed)) return { ok: false, reason: `table "${t}" is not part of this project's schema` };
  }
  // A query that references no table at all (SELECT 1) is fine; anything touching catalogs was
  // already rejected by the allow-list (information_schema / pg_catalog / sqlite_master are never allowed).
  const limited = applyLimit(s, max);
  if (!limited) return { ok: false, reason: `FETCH FIRST exceeds the ${max} row cap` };
  return { ok: true, sql: limited.sql, tables: Array.from(new Set(tables.map(t => t.toLowerCase()))), limit: limited.limit };
}

// ---------------------------------------------------------------- future write path (not executed in V1)

export type WriteClass = { kind: "insert" | "update" | "delete" | "ddl" | "other"; hasWhere: boolean; table?: string };
export function classifyWrite(sql: string): WriteClass {
  const s = stripStringsStd(sql.normalize("NFKC").trim().replace(/;+\s*$/, ""));
  const first = (/^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i.exec(s)?.[1] ?? "").toLowerCase();
  const hasWhere = /\bwhere\b/i.test(s);
  if (first === "insert") return { kind: "insert", hasWhere, table: /\binto\s+([\w".`]+)/i.exec(s)?.[1] };
  if (first === "update") return { kind: "update", hasWhere, table: /^\s*update\s+(?:only\s+)?([\w".`]+)/i.exec(s)?.[1] };
  if (first === "delete") return { kind: "delete", hasWhere, table: /\bfrom\s+(?:only\s+)?([\w".`]+)/i.exec(s)?.[1] };
  if (["create", "alter", "drop", "truncate", "rename", "grant", "revoke", "comment"].includes(first)) return { kind: "ddl", hasWhere };
  return { kind: "other", hasWhere };
}
