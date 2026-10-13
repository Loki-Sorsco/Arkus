// Persist an introspected schema as a Snapshot(kind "schema") with table/column Nodes and
// references/contains Edges, and load it back as TableFact[] without touching the live database.
import { createHash } from "node:crypto";
import { prisma, j } from "@/lib/db";
import { nodeKey, type TableFact, type ColumnFact } from "./types";
import type { IntrospectResult } from "./introspect";

export interface SchemaSnapshotInfo { snapshotId: string; version: string; stats: Record<string, unknown>; reused: boolean }

export function schemaVersion(tables: TableFact[]): string {
  const canon = [...tables].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
    name: t.name,
    columns: t.columns.map(c => ({ name: c.name, type: c.type, nullable: c.nullable, pk: c.pk, unique: c.unique, default: c.default, references: c.references })),
    indexes: t.indexes,
  }));
  return createHash("sha1").update(JSON.stringify(canon)).digest("hex");
}

export async function persistSchemaSnapshot(projectId: string, sourceId: string, result: IntrospectResult): Promise<SchemaSnapshotInfo> {
  const version = schemaVersion(result.tables);
  const stats = { tables: result.stats.tables, columns: result.stats.columns, fks: result.stats.fks, indexes: result.stats.indexes, viewsSkipped: result.stats.viewsSkipped, engineVersion: result.engineVersion };
  const existing = await prisma.snapshot.findFirst({ where: { projectId, sourceId, kind: "schema", version, status: "ready" } });
  if (existing) {
    await prisma.snapshot.update({ where: { id: existing.id }, data: { stats: JSON.stringify(stats), createdAt: new Date() } });
    return { snapshotId: existing.id, version, stats, reused: true };
  }
  const snap = await prisma.snapshot.create({ data: { projectId, sourceId, kind: "schema", version, status: "building", stats: JSON.stringify(stats) } });
  const nodes: { snapshotId: string; type: string; key: string; name: string; attrs: string; evidence: string }[] = [];
  const edges: { snapshotId: string; fromKey: string; toKey: string; type: string }[] = [];
  const ev = JSON.stringify([{ kind: "static", note: "db introspection" }]);
  const tableKeys = new Set(result.tables.map(t => nodeKey.table(t.name)));
  for (const t of result.tables) {
    const tk = nodeKey.table(t.name);
    nodes.push({ snapshotId: snap.id, type: "table", key: tk, name: t.name, evidence: ev, attrs: JSON.stringify({ columns: t.columns, rowEstimate: t.rowEstimate, source: t.source, indexes: t.indexes ?? [] }) });
    for (const c of t.columns) {
      const ck = nodeKey.column(t.name, c.name);
      nodes.push({ snapshotId: snap.id, type: "column", key: ck, name: c.name, evidence: ev, attrs: JSON.stringify({ type: c.type, nullable: c.nullable, pk: c.pk, unique: c.unique, default: c.default, references: c.references, index: c.index }) });
      edges.push({ snapshotId: snap.id, fromKey: tk, toKey: ck, type: "contains" });
      if (c.references) {
        const rt = nodeKey.table(c.references.table);
        if (tableKeys.has(rt)) {
          edges.push({ snapshotId: snap.id, fromKey: ck, toKey: nodeKey.column(c.references.table, c.references.column), type: "references" });
          edges.push({ snapshotId: snap.id, fromKey: tk, toKey: rt, type: "references" });
        }
      }
    }
  }
  const seen = new Set<string>();
  const uniqueEdges = edges.filter(e => { const k = `${e.fromKey}>${e.type}>${e.toKey}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (let i = 0; i < nodes.length; i += 500) await prisma.node.createMany({ data: nodes.slice(i, i + 500) });
  for (let i = 0; i < uniqueEdges.length; i += 500) await prisma.edge.createMany({ data: uniqueEdges.slice(i, i + 500) });
  await prisma.snapshot.update({ where: { id: snap.id }, data: { status: "ready", log: JSON.stringify([{ t: Date.now(), stage: "introspect", msg: `${result.stats.tables} tables, ${result.stats.columns} columns in ${result.stats.ms}ms`, level: "info" }]) } });
  return { snapshotId: snap.id, version, stats, reused: false };
}

/** Table nodes of any snapshot (schema or code) rebuilt into TableFact[]. With `declared`, a code
 * snapshot's tables come back as the code declared them (codeSource / codeColumns, kept by the
 * resolver when the live schema was merged in) instead of the live columns. */
export async function loadSchemaSnapshotTables(snapshotId: string, opts: { declared?: boolean } = {}): Promise<TableFact[]> {
  const rows = await prisma.node.findMany({ where: { snapshotId, type: "table" }, orderBy: { name: "asc" } });
  return rows.map(n => {
    const a = j<{ columns?: ColumnFact[]; rowEstimate?: number; indexes?: TableFact["indexes"]; source?: TableFact["source"]; modelName?: string; codeSource?: TableFact["source"]; codeColumns?: ColumnFact[]; codeFile?: string }>(n.attrs, {});
    const useDecl = opts.declared && a.codeSource;
    const t: TableFact = { name: n.name, modelName: a.modelName, columns: (useDecl ? a.codeColumns : a.columns) ?? [], source: (useDecl ? a.codeSource : a.source) ?? "introspection", rowEstimate: a.rowEstimate, indexes: useDecl ? [] : (a.indexes ?? []), file: (useDecl ? a.codeFile : n.file) ?? undefined, line: n.lineStart ?? undefined };
    return t;
  });
}

/** Latest ready schema snapshot for the env (via its db Source), rebuilt into TableFact[]. */
export async function loadSchemaTables(projectId: string, env = "dev"): Promise<{ tables: TableFact[]; snapshotId?: string; version?: string; createdAt?: Date; engine?: string }> {
  const source = await prisma.source.findFirst({ where: { projectId, kind: "db", env }, orderBy: { createdAt: "desc" } });
  if (!source) return { tables: [] };
  const snap = await prisma.snapshot.findFirst({ where: { projectId, sourceId: source.id, kind: "schema", status: "ready" }, orderBy: { createdAt: "desc" } });
  if (!snap) return { tables: [] };
  const tables = (await loadSchemaSnapshotTables(snap.id)).map(t => ({ ...t, source: "introspection" as const }));
  const cfg = j<{ engine?: string }>(source.config, {});
  return { tables, snapshotId: snap.id, version: snap.version, createdAt: snap.createdAt, engine: cfg.engine };
}
