// Pure structural diff between two TableFact[] (schema snapshots, or live schema vs code).
// Names are matched case-insensitively; nothing here touches a database.
import type { ColumnFact, TableFact } from "./types";

export interface ColumnChange { name: string; from: Partial<ColumnFact>; to: Partial<ColumnFact>; fields: string[] }
export interface TableDiff {
  table: string;
  addedColumns: ColumnFact[];
  removedColumns: ColumnFact[];
  changedColumns: ColumnChange[];
  addedIndexes: { name?: string; columns: string[]; unique?: boolean }[];
  removedIndexes: { name?: string; columns: string[]; unique?: boolean }[];
}
export interface SchemaDiff {
  addedTables: string[];
  removedTables: string[];
  changedTables: TableDiff[];
  summary: string;
  counts: { addedTables: number; removedTables: number; changedTables: number; addedColumns: number; removedColumns: number; changedColumns: number; addedIndexes: number; removedIndexes: number; total: number };
}

const low = (s: string) => s.toLowerCase();
const norm = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : v);
const colShape = (c: ColumnFact) => ({
  type: norm(c.type ? String(c.type).toLowerCase() : undefined),
  nullable: Boolean(c.nullable),
  pk: Boolean(c.pk),
  unique: Boolean(c.unique),
  default: norm(c.default),
  references: c.references ? `${low(c.references.table)}.${low(c.references.column)}` : undefined,
});
const idxKey = (i: { name?: string; columns: string[]; unique?: boolean }) => `${i.columns.map(low).join(",")}|${i.unique ? "u" : "n"}`;

export function diffTable(before: TableFact, after: TableFact): TableDiff | null {
  const bCols = new Map(before.columns.map(c => [low(c.name), c]));
  const aCols = new Map(after.columns.map(c => [low(c.name), c]));
  const addedColumns: ColumnFact[] = [], removedColumns: ColumnFact[] = [], changedColumns: ColumnChange[] = [];
  for (const [k, c] of aCols) if (!bCols.has(k)) addedColumns.push(c);
  for (const [k, c] of bCols) if (!aCols.has(k)) removedColumns.push(c);
  for (const [k, b] of bCols) {
    const a = aCols.get(k); if (!a) continue;
    const bs = colShape(b), as = colShape(a);
    const fields = (Object.keys(bs) as (keyof typeof bs)[]).filter(f => bs[f] !== as[f]);
    if (!fields.length) continue;
    const pick = (c: ColumnFact) => Object.fromEntries(fields.map(f => [f, f === "references" ? c.references : (c as unknown as Record<string, unknown>)[f]]));
    changedColumns.push({ name: a.name, from: pick(b), to: pick(a), fields });
  }
  const bIdx = new Map((before.indexes ?? []).map(i => [idxKey(i), i]));
  const aIdx = new Map((after.indexes ?? []).map(i => [idxKey(i), i]));
  const addedIndexes = [...aIdx].filter(([k]) => !bIdx.has(k)).map(([, i]) => i);
  const removedIndexes = [...bIdx].filter(([k]) => !aIdx.has(k)).map(([, i]) => i);
  if (!addedColumns.length && !removedColumns.length && !changedColumns.length && !addedIndexes.length && !removedIndexes.length) return null;
  return { table: after.name, addedColumns, removedColumns, changedColumns, addedIndexes, removedIndexes };
}

export function diffSchemas(before: TableFact[], after: TableFact[]): SchemaDiff {
  const b = new Map(before.map(t => [low(t.name), t]));
  const a = new Map(after.map(t => [low(t.name), t]));
  const addedTables = [...a].filter(([k]) => !b.has(k)).map(([, t]) => t.name).sort();
  const removedTables = [...b].filter(([k]) => !a.has(k)).map(([, t]) => t.name).sort();
  const changedTables: TableDiff[] = [];
  for (const [k, bt] of b) { const at = a.get(k); if (!at) continue; const d = diffTable(bt, at); if (d) changedTables.push(d); }
  changedTables.sort((x, y) => x.table.localeCompare(y.table));
  const sum = (f: (d: TableDiff) => number) => changedTables.reduce((n, d) => n + f(d), 0);
  const counts = {
    addedTables: addedTables.length, removedTables: removedTables.length, changedTables: changedTables.length,
    addedColumns: sum(d => d.addedColumns.length), removedColumns: sum(d => d.removedColumns.length), changedColumns: sum(d => d.changedColumns.length),
    addedIndexes: sum(d => d.addedIndexes.length), removedIndexes: sum(d => d.removedIndexes.length), total: 0,
  };
  counts.total = counts.addedTables + counts.removedTables + counts.addedColumns + counts.removedColumns + counts.changedColumns + counts.addedIndexes + counts.removedIndexes;
  return { addedTables, removedTables, changedTables, counts, summary: summarize(counts) };
}

export function summarize(c: SchemaDiff["counts"]): string {
  if (!c.total) return "schema unchanged";
  const parts: string[] = [];
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (c.addedTables) parts.push(`+${pl(c.addedTables, "table")}`);
  if (c.removedTables) parts.push(`-${pl(c.removedTables, "table")}`);
  if (c.addedColumns) parts.push(`+${pl(c.addedColumns, "column")}`);
  if (c.removedColumns) parts.push(`-${pl(c.removedColumns, "column")}`);
  if (c.changedColumns) parts.push(`${pl(c.changedColumns, "column")} changed`);
  if (c.addedIndexes || c.removedIndexes) parts.push(`${pl(c.addedIndexes + c.removedIndexes, "index")} changed`);
  return parts.join(", ");
}
