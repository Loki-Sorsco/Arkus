// Schema-change engine, pure part: the SchemaChange vocabulary, its zod schema, `renderDdl` (statements per
// engine, identifiers quoted) and `validateSchemaChange` (names against the snapshot, types against the
// engine, no secret-named columns, typed confirmation for drops). Nothing here touches a database;
// ddl-apply.ts runs the statements and re-syncs the snapshot. Shared by the AI action cards (preview) and
// the manual schema UI.
import { z } from "zod";
import type { Engine } from "./dbconn";
import { isSecretColumn } from "./browse";
import type { ColumnFact, TableFact } from "./types";

export type ColumnRef = { table: string; column: string };
export type NewColumn = { name: string; type: string; pk?: boolean; nullable?: boolean; default?: string | null; unique?: boolean; references?: ColumnRef };
export type SchemaChange =
  | { kind: "create_table"; table: string; columns: NewColumn[] }
  | { kind: "rename_table"; table: string; to: string }
  | { kind: "drop_table"; table: string }
  | { kind: "add_column"; table: string; column: string; type: string; nullable?: boolean; default?: string | null; unique?: boolean; references?: ColumnRef }
  | { kind: "rename_column"; table: string; column: string; to: string }
  | { kind: "alter_column"; table: string; column: string; type?: string; nullable?: boolean; default?: string | null }
  | { kind: "drop_column"; table: string; column: string }
  | { kind: "create_index"; table: string; columns: string[]; name?: string; unique?: boolean }
  | { kind: "drop_index"; table: string; name: string };

const ident = z.string().min(1).max(63);
const ref = z.object({ table: ident, column: ident });
const dflt = z.union([z.string(), z.number(), z.boolean()]).nullable().optional().transform((v) => (v === undefined ? undefined : v === null ? null : String(v)));
const newColumn = z.object({ name: ident, type: z.string().min(1).max(80), pk: z.boolean().optional(), nullable: z.boolean().optional(), default: dflt, unique: z.boolean().optional(), references: ref.optional() });
export const SchemaChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_table"), table: ident, columns: z.array(newColumn).min(1).max(60) }),
  z.object({ kind: z.literal("rename_table"), table: ident, to: ident }),
  z.object({ kind: z.literal("drop_table"), table: ident }),
  z.object({ kind: z.literal("add_column"), table: ident, column: ident, type: z.string().min(1).max(80), nullable: z.boolean().optional(), default: dflt, unique: z.boolean().optional(), references: ref.optional() }),
  z.object({ kind: z.literal("rename_column"), table: ident, column: ident, to: ident }),
  z.object({ kind: z.literal("alter_column"), table: ident, column: ident, type: z.string().min(1).max(80).optional(), nullable: z.boolean().optional(), default: dflt }),
  z.object({ kind: z.literal("drop_column"), table: ident, column: ident }),
  z.object({ kind: z.literal("create_index"), table: ident, columns: z.array(ident).min(1).max(16), name: ident.optional(), unique: z.boolean().optional() }),
  z.object({ kind: z.literal("drop_index"), table: ident, name: ident }),
]);

export class DdlError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

// Column types the three engines accept, as the model / UI is told to use them. A parenthesised size /
// precision is allowed after any of them ("varchar(120)", "numeric(10,2)").
const TYPES: Record<Engine, RegExp> = {
  postgres: /^(text|varchar|character varying|char|character|citext|uuid|boolean|bool|smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|real|double precision|float4|float8|numeric|decimal|money|date|time|timetz|timestamp|timestamptz|timestamp with(?:out)? time zone|interval|json|jsonb|bytea|inet)(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?(\s*\[\])?$/i,
  mysql: /^(varchar|char|text|tinytext|mediumtext|longtext|tinyint|smallint|mediumint|int|integer|bigint|boolean|bool|float|double|decimal|numeric|date|datetime|timestamp|time|year|json|blob|tinyblob|mediumblob|longblob|binary|varbinary|enum)(\s*\(\s*[^()]{1,120}\s*\))?(\s+unsigned)?$/i,
  sqlite: /^(text|integer|int|real|numeric|blob|boolean|bool|datetime|date|timestamp|varchar|char|bigint|double|float|decimal|json)(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?$/i,
};
/** Validate a column type for the engine; returns the normalised type or throws. */
export function checkColumnType(engine: Engine, type: string): string {
  const t = String(type ?? "").trim().replace(/\s+/g, " ");
  if (!t || t.length > 80 || !TYPES[engine].test(t)) throw new DdlError(`"${t || "?"}" is not a column type ${engine} accepts here. Use e.g. ${engine === "postgres" ? "text, integer, boolean, timestamptz, jsonb" : engine === "mysql" ? "varchar(255), int, tinyint(1), datetime, json" : "TEXT, INTEGER, REAL, BLOB"}.`);
  return t;
}
/** Render a DEFAULT literal safely: numbers / booleans / SQL keywords as-is, everything else as a quoted string. */
export function defaultLiteral(engine: Engine, v: string | number | boolean | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return engine === "postgres" ? String(v) : v ? "1" : "0";
  const s = String(v).trim();
  if (/^(current_timestamp|current_date|current_time|null)$/i.test(s)) return s.toUpperCase();
  if (/^now\(\)$/i.test(s)) return engine === "sqlite" ? "CURRENT_TIMESTAMP" : "now()";
  if (/^(true|false)$/i.test(s)) return engine === "postgres" ? s.toLowerCase() : /^true$/i.test(s) ? "1" : "0";
  if (/^(gen_random_uuid|uuid_generate_v4|uuid)\(\)$/i.test(s)) return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

export const quoteIdent = (engine: Engine, n: string) => (engine === "mysql" ? "`" + n.replace(/`/g, "``") + "`" : '"' + n.replace(/"/g, '""') + '"');
const qTable = (engine: Engine, name: string) => name.split(".").map((p) => quoteIdent(engine, p)).join(".");
export const indexName = (table: string, columns: string[], unique?: boolean) => `${table.split(".").pop()}_${columns.join("_")}_${unique ? "key" : "idx"}`.slice(0, 63);

function columnDef(engine: Engine, c: NewColumn, inline: { pk: boolean; unique: boolean }): string {
  const parts = [`${quoteIdent(engine, c.name)} ${c.type}`];
  if (inline.pk && c.pk) parts.push("PRIMARY KEY");
  if (c.nullable === false && !c.pk) parts.push("NOT NULL");
  if (inline.unique && c.unique && !c.pk) parts.push("UNIQUE");
  const d = defaultLiteral(engine, c.default);
  if (d !== null) parts.push(`DEFAULT ${d}`);
  if (c.references) parts.push(`REFERENCES ${qTable(engine, c.references.table)} (${quoteIdent(engine, c.references.column)})`);
  return parts.join(" ");
}

/** The SQL statements for a change, per engine. Throws DdlError for things the engine cannot do. `current`
 * is the column's present definition (needed by MySQL's MODIFY COLUMN when the type is not given). */
export function renderDdl(change: SchemaChange, engine: Engine, current?: ColumnFact): string[] {
  const q = (n: string) => quoteIdent(engine, n);
  const t = qTable(engine, change.table);
  switch (change.kind) {
    case "create_table": {
      const pks = change.columns.filter((c) => c.pk);
      const lines = change.columns.map((c) => "  " + columnDef(engine, c, { pk: pks.length === 1, unique: true }));
      if (pks.length > 1) lines.push(`  PRIMARY KEY (${pks.map((c) => q(c.name)).join(", ")})`);
      return [`CREATE TABLE ${t} (\n${lines.join(",\n")}\n)`];
    }
    case "rename_table": return engine === "mysql" ? [`RENAME TABLE ${t} TO ${q(change.to)}`] : [`ALTER TABLE ${t} RENAME TO ${q(change.to)}`];
    case "drop_table": return [`DROP TABLE ${t}`];
    case "add_column": {
      // SQLite cannot add a UNIQUE column in place: add it, then a unique index.
      const col: NewColumn = { name: change.column, type: change.type, nullable: change.nullable, default: change.default, unique: change.unique, references: change.references };
      const out = [`ALTER TABLE ${t} ADD COLUMN ${columnDef(engine, col, { pk: false, unique: engine !== "sqlite" })}`];
      if (engine === "sqlite" && change.unique) out.push(`CREATE UNIQUE INDEX ${q(indexName(change.table, [change.column], true))} ON ${t} (${q(change.column)})`);
      return out;
    }
    case "rename_column": return [`ALTER TABLE ${t} RENAME COLUMN ${q(change.column)} TO ${q(change.to)}`];
    case "alter_column": {
      if (engine === "sqlite") throw new DdlError("SQLite cannot change a column's type; recreate the table");
      if (change.type === undefined && change.nullable === undefined && change.default === undefined) throw new DdlError("alter_column changes nothing: give a type, nullable or default");
      const c = q(change.column);
      if (engine === "postgres") {
        const out: string[] = [];
        if (change.type) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${change.type}`);
        if (change.nullable !== undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${change.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`);
        if (change.default !== undefined) out.push(change.default === null ? `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT` : `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${defaultLiteral(engine, change.default)}`);
        return out;
      }
      // MySQL rewrites the whole column definition.
      const type = change.type ?? current?.type;
      if (!type) throw new DdlError("MySQL needs the column type to alter a column");
      const nullable = change.nullable ?? current?.nullable ?? true;
      const def = change.default === undefined ? (current?.default != null && current.default !== "" ? current.default : null) : change.default === null ? null : defaultLiteral(engine, change.default);
      return [`ALTER TABLE ${t} MODIFY COLUMN ${c} ${type} ${nullable ? "NULL" : "NOT NULL"}${def !== null ? ` DEFAULT ${def}` : ""}`];
    }
    case "drop_column": return [`ALTER TABLE ${t} DROP COLUMN ${q(change.column)}`];
    case "create_index": return [`CREATE ${change.unique ? "UNIQUE " : ""}INDEX ${q(change.name || indexName(change.table, change.columns, change.unique))} ON ${t} (${change.columns.map(q).join(", ")})`];
    case "drop_index": return engine === "mysql" ? [`DROP INDEX ${q(change.name)} ON ${t}`] : [`DROP INDEX ${q(change.name)}`];
  }
}

export function findTable(tables: TableFact[], name: string): TableFact | undefined {
  const n = String(name ?? "").toLowerCase();
  return tables.find((t) => t.name.toLowerCase() === n) ?? tables.find((t) => (t.modelName || "").toLowerCase() === n) ?? tables.find((t) => t.name.toLowerCase().split(".").pop() === n);
}
const findColumn = (t: TableFact, name: string) => t.columns.find((c) => c.name.toLowerCase() === String(name ?? "").toLowerCase());
const secret = (name: string) => isSecretColumn(name) || isSecretColumn(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
const newName = (n: string, what: string) => { if (!IDENT_RE.test(n)) throw new DdlError(`"${n}" is not a valid ${what} name (letters, digits and _, max 63)`); if (secret(n)) throw new DdlError(`"${n}" looks like a secret column; Arkus never creates or touches secrets`); return n; };

/** Check a change against the snapshot and engine. Returns the change with canonical table names plus the
 * current column (for MySQL alter) — or throws DdlError. `confirm` must equal the table name for drops. */
export function validateSchemaChange(raw: unknown, tables: TableFact[], engine: Engine, opts: { confirm?: string; requireConfirm?: boolean } = {}): { change: SchemaChange; current?: ColumnFact } {
  const p = SchemaChangeSchema.safeParse(raw);
  if (!p.success) throw new DdlError(`invalid schema change (${p.error.issues[0]?.path.join(".") || "?"}: ${p.error.issues[0]?.message || "invalid"})`);
  const ch = p.data as SchemaChange;
  const needConfirm = opts.requireConfirm !== false;
  const refOk = (r: ColumnRef) => { const rt = findTable(tables, r.table); if (!rt) throw new DdlError(`references unknown table "${r.table}"`); const rc = findColumn(rt, r.column); if (!rc) throw new DdlError(`references unknown column ${rt.name}.${r.column}`); return { table: rt.name, column: rc.name }; };
  if (ch.kind === "create_table") {
    if (findTable(tables, ch.table)) throw new DdlError(`table "${ch.table}" already exists`);
    newName(ch.table, "table");
    const seen = new Set<string>();
    const columns = ch.columns.map((c) => { newName(c.name, "column"); if (seen.has(c.name.toLowerCase())) throw new DdlError(`column "${c.name}" is listed twice`); seen.add(c.name.toLowerCase()); return { ...c, type: checkColumnType(engine, c.type), ...(c.references ? { references: refOk(c.references) } : {}) }; });
    return { change: { kind: "create_table", table: ch.table, columns } };
  }
  const t = findTable(tables, ch.table);
  if (!t) throw new DdlError(`unknown table "${ch.table}" — it is not in the schema snapshot`);
  const existing = (name: string) => { const c = findColumn(t, name); if (!c) throw new DdlError(`unknown column ${t.name}.${name}`); if (secret(c.name)) throw new DdlError(`${t.name}.${c.name} is a secret-like column; Arkus never touches secrets`); return c; };
  switch (ch.kind) {
    case "rename_table": newName(ch.to, "table"); if (findTable(tables, ch.to)) throw new DdlError(`table "${ch.to}" already exists`); return { change: { ...ch, table: t.name } };
    case "drop_table": if (needConfirm && opts.confirm !== t.name) throw new DdlError(`Type the table name (${t.name}) to confirm dropping it`, 428); return { change: { ...ch, table: t.name } };
    case "add_column": {
      newName(ch.column, "column");
      if (findColumn(t, ch.column)) throw new DdlError(`${t.name} already has a column named ${ch.column}`);
      const type = checkColumnType(engine, ch.type);
      if (ch.nullable === false && defaultLiteral(engine, ch.default) === null && (t.rowEstimate ?? 1) > 0) throw new DdlError("A NOT NULL column on a table with rows needs a default value");
      return { change: { ...ch, table: t.name, type, ...(ch.references ? { references: refOk(ch.references) } : {}) } };
    }
    case "rename_column": { const c = existing(ch.column); newName(ch.to, "column"); if (findColumn(t, ch.to)) throw new DdlError(`${t.name} already has a column named ${ch.to}`); return { change: { ...ch, table: t.name, column: c.name }, current: c }; }
    case "alter_column": { const c = existing(ch.column); if (c.pk) throw new DdlError(`${t.name}.${c.name} is the primary key; it is not altered from here`); return { change: { ...ch, table: t.name, column: c.name, ...(ch.type ? { type: checkColumnType(engine, ch.type) } : {}) }, current: c }; }
    case "drop_column": { const c = existing(ch.column); if (c.pk) throw new DdlError(`${t.name}.${c.name} is the primary key and cannot be dropped`); if (needConfirm && opts.confirm !== t.name) throw new DdlError(`Type the table name (${t.name}) to confirm dropping ${t.name}.${c.name}`, 428); return { change: { ...ch, table: t.name, column: c.name }, current: c }; }
    case "create_index": {
      const columns = ch.columns.map((n) => existing(n).name);
      if (ch.name) newName(ch.name, "index");
      const name = (ch.name || indexName(t.name, columns, ch.unique)).toLowerCase();
      if ((t.indexes ?? []).some((i) => (i.name || "").toLowerCase() === name)) throw new DdlError(`index "${name}" already exists on ${t.name}`);
      return { change: { ...ch, table: t.name, columns } };
    }
    case "drop_index": {
      if (!IDENT_RE.test(ch.name)) throw new DdlError(`"${ch.name}" is not a valid index name`);
      const known = (t.indexes ?? []).filter((i) => i.name);
      if (known.length && !known.some((i) => i.name!.toLowerCase() === ch.name.toLowerCase())) throw new DdlError(`"${ch.name}" is not an index of ${t.name} (known: ${known.map((i) => i.name).join(", ")})`);
      return { change: { ...ch, table: t.name } };
    }
  }
}
