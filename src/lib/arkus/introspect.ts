// Schema introspection → TableFact[] (shape shared with the code extractors). Read-only catalog
// queries only; row counts come from planner statistics (pg_class.reltuples / TABLE_ROWS /
// max(rowid)), never COUNT(*). V1 skips views (TableFact has no slot for them) — noted in stats.
import type { TableFact, ColumnFact } from "./types";
import type { DbConn } from "./dbconn";

export interface IntrospectResult {
  tables: TableFact[];
  engineVersion: string;
  stats: { tables: number; columns: number; fks: number; indexes: number; viewsSkipped: number; enums?: number; ms: number };
}

const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined; };
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

function finish(tables: TableFact[], engineVersion: string, viewsSkipped: number, t0: number, enums?: number): IntrospectResult {
  tables.sort((a, b) => a.name.localeCompare(b.name));
  for (const t of tables) if (t.rowEstimate === undefined) delete t.rowEstimate;
  return {
    tables, engineVersion,
    stats: {
      tables: tables.length,
      columns: tables.reduce((n, t) => n + t.columns.length, 0),
      fks: tables.reduce((n, t) => n + t.columns.filter(c => c.references).length, 0),
      indexes: tables.reduce((n, t) => n + (t.indexes?.length ?? 0), 0),
      viewsSkipped, ...(enums !== undefined ? { enums } : {}), ms: Date.now() - t0,
    },
  };
}

// ---------------------------------------------------------------- postgres

async function introspectPostgres(conn: DbConn, t0: number): Promise<IntrospectResult> {
  const SCHEMAS = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";
  const nameOf = (schema: string, table: string) => (schema === "public" ? table : `${schema}.${table}`);
  const version = str((await conn.query("SELECT current_setting('server_version') AS v")).rows[0]?.v) ?? "";
  const rel = await conn.query(`SELECT n.nspname AS schema, c.relname AS name, c.reltuples::float8 AS est FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND ${SCHEMAS} ORDER BY 1, 2`);
  const views = await conn.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('v','m') AND ${SCHEMAS}`);
  const enums = await conn.query("SELECT t.typname AS name, string_agg(e.enumlabel, '|' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname");
  const enumMap = new Map(enums.rows.map(r => [String(r.name), String(r.labels)]));
  const cols = await conn.query("SELECT table_schema AS schema, table_name AS tbl, column_name AS col, data_type AS dt, udt_name AS udt, is_nullable AS nullable, column_default AS dflt, character_maximum_length AS len FROM information_schema.columns WHERE table_schema NOT LIKE 'pg\\_%' AND table_schema <> 'information_schema' ORDER BY table_schema, table_name, ordinal_position");
  const keys = await conn.query("SELECT tc.table_schema AS schema, tc.table_name AS tbl, tc.constraint_type AS kind, tc.constraint_name AS cname, kcu.column_name AS col FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema AND kcu.table_name = tc.table_name WHERE tc.constraint_type IN ('PRIMARY KEY','UNIQUE') ORDER BY tc.constraint_name, kcu.ordinal_position");
  const fks = await conn.query("SELECT kcu.table_schema AS schema, kcu.table_name AS tbl, kcu.column_name AS col, kcu2.table_schema AS rschema, kcu2.table_name AS rtbl, kcu2.column_name AS rcol FROM information_schema.referential_constraints rc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema JOIN information_schema.key_column_usage kcu2 ON kcu2.constraint_name = rc.unique_constraint_name AND kcu2.constraint_schema = rc.unique_constraint_schema AND kcu2.ordinal_position = kcu.position_in_unique_constraint");
  const idx = await conn.query("SELECT schemaname AS schema, tablename AS tbl, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> 'information_schema'");

  const tables = new Map<string, TableFact>();
  for (const r of rel.rows) {
    const est = Number(r.est);
    tables.set(`${r.schema}.${r.name}`, { name: nameOf(String(r.schema), String(r.name)), columns: [], source: "introspection", rowEstimate: est >= 0 ? Math.round(est) : undefined, indexes: [] });
  }
  const col = (schema: unknown, tbl: unknown, c: unknown) => tables.get(`${schema}.${tbl}`)?.columns.find(x => x.name === String(c));
  for (const r of cols.rows) {
    const t = tables.get(`${r.schema}.${r.tbl}`); if (!t) continue;
    let type = String(r.udt ?? r.dt);
    if (type.startsWith("_")) type = type.slice(1) + "[]";
    if (enumMap.has(type)) type = `enum(${enumMap.get(type)})`;
    else if (r.len) type += `(${r.len})`;
    t.columns.push({ name: String(r.col), type, nullable: r.nullable === "YES", default: str(r.dflt) });
  }
  const uniqueGroups = new Map<string, number>();
  for (const r of keys.rows) uniqueGroups.set(String(r.cname), (uniqueGroups.get(String(r.cname)) ?? 0) + 1);
  for (const r of keys.rows) {
    const c = col(r.schema, r.tbl, r.col); if (!c) continue;
    if (r.kind === "PRIMARY KEY") c.pk = true;
    else if (uniqueGroups.get(String(r.cname)) === 1) c.unique = true;
  }
  for (const r of fks.rows) {
    const c = col(r.schema, r.tbl, r.col); if (!c) continue;
    c.references = { table: nameOf(String(r.rschema), String(r.rtbl)), column: String(r.rcol) };
  }
  for (const r of idx.rows) {
    const t = tables.get(`${r.schema}.${r.tbl}`); if (!t) continue;
    const def = String(r.def);
    const m = /\(([^)]*)\)/.exec(def);
    const columns = m ? m[1].split(",").map(s => s.trim().replace(/^"|"$/g, "").split(/\s+/)[0]) : [];
    t.indexes!.push({ name: String(r.name), columns, unique: /^CREATE UNIQUE/i.test(def) });
    for (const cn of columns) { const c = t.columns.find(x => x.name === cn); if (c) c.index = true; }
  }
  return finish([...tables.values()], version, Number(views.rows[0]?.n ?? 0), t0, enumMap.size);
}

// ---------------------------------------------------------------- mysql

async function introspectMysql(conn: DbConn, t0: number): Promise<IntrospectResult> {
  const version = str((await conn.query("SELECT VERSION() AS v")).rows[0]?.v) ?? "";
  const rel = await conn.query("SELECT TABLE_NAME AS name, TABLE_ROWS AS est, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
  const cols = await conn.query("SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS ckey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION");
  const fks = await conn.query("SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS rtbl, REFERENCED_COLUMN_NAME AS rcol FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL");
  const idx = await conn.query("SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS nonunique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX");
  const tables = new Map<string, TableFact>();
  let viewsSkipped = 0;
  for (const r of rel.rows) {
    if (r.kind !== "BASE TABLE") { viewsSkipped++; continue; }
    tables.set(String(r.name), { name: String(r.name), columns: [], source: "introspection", rowEstimate: num(r.est), indexes: [] });
  }
  for (const r of cols.rows) {
    const t = tables.get(String(r.tbl)); if (!t) continue;
    t.columns.push({ name: String(r.col), type: String(r.type), nullable: r.nullable === "YES", default: str(r.dflt), pk: r.ckey === "PRI" || undefined, unique: r.ckey === "UNI" || undefined });
  }
  for (const r of fks.rows) {
    const c = tables.get(String(r.tbl))?.columns.find(x => x.name === String(r.col)); if (!c) continue;
    c.references = { table: String(r.rtbl), column: String(r.rcol) };
  }
  const grouped = new Map<string, { table: TableFact; name: string; columns: string[]; unique: boolean }>();
  for (const r of idx.rows) {
    const t = tables.get(String(r.tbl)); if (!t) continue;
    const k = `${r.tbl}::${r.name}`;
    if (!grouped.has(k)) grouped.set(k, { table: t, name: String(r.name), columns: [], unique: Number(r.nonunique) === 0 });
    grouped.get(k)!.columns.push(String(r.col));
    const c = t.columns.find(x => x.name === String(r.col)); if (c) c.index = true;
  }
  for (const g of grouped.values()) g.table.indexes!.push({ name: g.name, columns: g.columns, unique: g.unique });
  return finish([...tables.values()], version, viewsSkipped, t0);
}

// ---------------------------------------------------------------- sqlite

async function introspectSqlite(conn: DbConn, t0: number): Promise<IntrospectResult> {
  const version = str((await conn.query("SELECT sqlite_version() AS v")).rows[0]?.v) ?? "";
  const rel = await conn.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables: TableFact[] = [];
  let viewsSkipped = 0;
  for (const r of rel.rows) {
    if (r.type === "view") { viewsSkipped++; continue; }
    const name = String(r.name);
    const q = conn.quoteId(name);
    const info = await conn.query(`PRAGMA table_info(${q})`);
    const columns: ColumnFact[] = info.rows.map(c => ({
      name: String(c.name), type: String(c.type || "any"), nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
      pk: Number(c.pk) > 0 || undefined, default: str(c.dflt_value),
    }));
    const fkl = await conn.query(`PRAGMA foreign_key_list(${q})`);
    for (const f of fkl.rows) {
      const c = columns.find(x => x.name === String(f.from)); if (!c) continue;
      c.references = { table: String(f.table), column: String(f.to || "id") };
    }
    const idxl = await conn.query(`PRAGMA index_list(${q})`);
    const indexes: NonNullable<TableFact["indexes"]> = [];
    for (const ix of idxl.rows) {
      const cols = await conn.query(`PRAGMA index_info(${conn.quoteId(String(ix.name))})`);
      const names = cols.rows.map(c => String(c.name));
      const unique = Number(ix.unique) === 1;
      indexes.push({ name: String(ix.name), columns: names, unique });
      for (const cn of names) { const c = columns.find(x => x.name === cn); if (c) { c.index = true; if (unique && names.length === 1 && ix.origin === "u") c.unique = true; } }
    }
    let rowEstimate: number | undefined;
    try { rowEstimate = num((await conn.query(`SELECT max(rowid) AS n FROM ${q}`)).rows[0]?.n) ?? 0; } catch { /* WITHOUT ROWID table */ }
    tables.push({ name, columns, source: "introspection", rowEstimate, indexes });
  }
  return finish(tables, version, viewsSkipped, t0);
}

export async function introspect(conn: DbConn): Promise<IntrospectResult> {
  const t0 = Date.now();
  if (conn.engine === "postgres") return introspectPostgres(conn, t0);
  if (conn.engine === "mysql") return introspectMysql(conn, t0);
  return introspectSqlite(conn, t0);
}
