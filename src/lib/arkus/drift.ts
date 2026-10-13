// Drift: the live database schema (latest introspection snapshot for the env) vs the tables the
// code declares (latest ready code snapshot; Prisma / Drizzle / SQL migrations ...). Informational
// only - Arkus never alters a database.
import { prisma } from "@/lib/db";
import { loadSchemaSnapshotTables } from "./schemastore";
import { diffSchemas, type SchemaDiff } from "./schemadiff";
import type { TableFact } from "./types";

export interface DriftResult {
  env: string;
  hasCode: boolean;
  hasDb: boolean;
  codeSource: string | null;                 // "prisma" | "sql" | "drizzle" | ... (most common among code tables)
  snapshotIds: { code: string | null; schema: string | null };
  tables: { db: number; code: number; compared: number };
  diff: SchemaDiff | null;                   // before = code, after = db  (addedTables = only in DB, removedTables = only in code)
}

const META_RE = /^(_prisma_migrations|drizzle_migrations|__drizzle_migrations|knex_migrations.*|schema_migrations|sqlite_sequence|ar_internal_metadata|django_migrations|alembic_version|flyway_schema_history)$/i;
const bare = (n: string) => n.split(".").pop() ?? n;
export const isMetaTable = (name: string) => META_RE.test(bare(name));

export async function computeDrift(projectId: string, env = "dev"): Promise<DriftResult> {
  const source = await prisma.source.findFirst({ where: { projectId, kind: "db", env }, orderBy: { createdAt: "desc" } });
  const [code, schema] = await Promise.all([
    prisma.snapshot.findFirst({ where: { projectId, kind: "code", status: "ready" }, orderBy: { createdAt: "desc" }, select: { id: true } }),
    source ? prisma.snapshot.findFirst({ where: { projectId, sourceId: source.id, kind: "schema", status: "ready" }, orderBy: { createdAt: "desc" }, select: { id: true } }) : Promise.resolve(null),
  ]);
  const codeTables: TableFact[] = code ? (await loadSchemaSnapshotTables(code.id, { declared: true })).filter(t => t.source !== "introspection" && !isMetaTable(t.name)) : [];
  const dbTables: TableFact[] = schema ? (await loadSchemaSnapshotTables(schema.id)).filter(t => !isMetaTable(t.name)) : [];
  const counts = new Map<string, number>();
  for (const t of codeTables) counts.set(t.source, (counts.get(t.source) ?? 0) + 1);
  const codeSource = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const hasCode = codeTables.length > 0, hasDb = dbTables.length > 0;
  // Code extractors usually know less than the catalog (no indexes, loose types); compare only what the code states.
  const diff = hasCode && hasDb ? diffSchemas(codeTables.map(t => stripUnknowns(t)), dbTables.map(t => stripUnknowns(t, codeTables))) : null;
  return { env, hasCode, hasDb, codeSource, snapshotIds: { code: code?.id ?? null, schema: schema?.id ?? null }, tables: { db: dbTables.length, code: codeTables.length, compared: diff ? Math.min(codeTables.length, dbTables.length) : 0 }, diff };
}

/** Normalise a table so that only comparable facts remain: names, nullability, pk, fk targets.
 * Types are compared loosely (Prisma "String" vs sqlite "TEXT" would otherwise flag every column). */
function stripUnknowns(t: TableFact, codeTables?: TableFact[]): TableFact {
  const codeT = codeTables?.find(c => c.name.toLowerCase() === t.name.toLowerCase());
  // A single-column unique index is how ORMs realise @unique, so it counts as "unique" on the column.
  const uniqueViaIndex = new Set((t.indexes ?? []).filter(i => i.unique && i.columns.length === 1).map(i => i.columns[0].toLowerCase()));
  return {
    name: t.name, source: t.source,
    columns: t.columns.map(c => {
      const codeC = codeT?.columns.find(x => x.name.toLowerCase() === c.name.toLowerCase());
      const unique = Boolean(c.unique) || uniqueViaIndex.has(c.name.toLowerCase()) || Boolean(c.pk);
      // The DB usually knows more than the code (extra unique indexes): only flag uniqueness the code also states.
      return { name: c.name, type: looseType(c.type), nullable: Boolean(c.nullable), pk: Boolean(c.pk), unique: codeTables ? unique && (!codeC || Boolean(codeC.unique) || Boolean(codeC.pk)) : unique, references: c.references ? { table: bare(c.references.table), column: c.references.column } : undefined };
    }),
    indexes: [],
  };
}

const looseType = (t: string): string => {
  const s = String(t || "").toLowerCase();
  if (/int|serial|bigint|smallint|number/.test(s) && !/point/.test(s)) return "int";
  if (/float|double|real|decimal|numeric|money/.test(s)) return "float";
  if (/bool|tinyint\(1\)/.test(s)) return "bool";
  if (/date|time/.test(s)) return "datetime";
  if (/json/.test(s)) return "json";
  if (/blob|bytea|binary|bytes/.test(s)) return "bytes";
  if (/char|text|string|uuid|enum|citext|varchar/.test(s)) return "string";
  return s || "any";
};
