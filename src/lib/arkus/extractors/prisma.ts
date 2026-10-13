// schema.prisma → TableFacts. Highest-confidence DB source for Node projects.
import type { ColumnFact, Extractor, TableFact } from "../types";

const SCALAR: Record<string, string> = { String: "text", Int: "integer", BigInt: "bigint", Float: "double precision", Decimal: "numeric", Boolean: "boolean", DateTime: "timestamptz", Json: "jsonb", Bytes: "bytea" };

export function parsePrismaSchema(src: string, file?: string): { tables: TableFact[]; modelToTable: Record<string, string>; enums: string[] } {
  const tables: TableFact[] = [];
  const modelToTable: Record<string, string> = {};
  const enums: string[] = [];
  const lines = src.split(/\r?\n/);
  const modelNames = new Set<string>();
  for (const l of lines) { const m = l.match(/^\s*model\s+(\w+)\s*\{/); if (m) modelNames.add(m[1]); const e = l.match(/^\s*enum\s+(\w+)\s*\{/); if (e) enums.push(e[1]); }

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*model\s+(\w+)\s*\{/);
    if (!m) { i++; continue; }
    const modelName = m[1];
    const start = i + 1;
    const cols: ColumnFact[] = [];
    const indexes: TableFact["indexes"] = [];
    let tableName = modelName;
    const relationFields: { field: string; target: string; fields?: string[]; references?: string[] }[] = [];
    i++;
    while (i < lines.length && !/^\s*\}/.test(lines[i])) {
      const raw = lines[i].split("//")[0].trim();
      i++;
      if (!raw) continue;
      const mm = raw.match(/^@@map\(\s*(?:name:\s*)?"([^"]+)"\s*\)/); if (mm) { tableName = mm[1]; continue; }
      const idx = raw.match(/^@@(index|unique)\(\s*\[([^\]]+)\]/); if (idx) { indexes.push({ columns: idx[2].split(",").map((s) => s.trim()), unique: idx[1] === "unique" }); continue; }
      const pk = raw.match(/^@@id\(\s*\[([^\]]+)\]/); if (pk) { for (const c of pk[1].split(",").map((s) => s.trim())) { const col = cols.find((x) => x.name === c); if (col) col.pk = true; } continue; }
      if (raw.startsWith("@@")) continue;
      const f = raw.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!f) continue;
      const [, fname, ftype, isList, optional, attrs] = f;
      if (modelNames.has(ftype)) {
        const rel = attrs.match(/@relation\(([^)]*)\)/);
        const fields = rel?.[1].match(/fields:\s*\[([^\]]+)\]/)?.[1].split(",").map((s) => s.trim());
        const references = rel?.[1].match(/references:\s*\[([^\]]+)\]/)?.[1].split(",").map((s) => s.trim());
        if (!isList) relationFields.push({ field: fname, target: ftype, fields, references });
        continue;
      }
      const col: ColumnFact = { name: attrs.match(/@map\("([^"]+)"\)/)?.[1] || fname, type: SCALAR[ftype] || (enums.includes(ftype) ? `enum ${ftype}` : ftype.toLowerCase()), nullable: !!optional };
      if (isList) col.type += "[]";
      if (/@id\b/.test(attrs)) { col.pk = true; col.nullable = false; }
      if (/@unique\b/.test(attrs)) col.unique = true;
      const def = attrs.match(/@default\(([^)]*\)?)\)?/); if (def) col.default = def[1].replace(/\)$/, "");
      if (/@db\.Uuid/.test(attrs) || (/uuid\(\)/.test(attrs) && ftype === "String")) col.type = "uuid";
      cols.push(col);
    }
    // FK columns from relation fields
    for (const r of relationFields) {
      const targetTable = r.target; // mapped later
      (r.fields || []).forEach((fcol, k) => {
        const col = cols.find((c) => c.name === fcol);
        if (col) col.references = { table: targetTable, column: r.references?.[k] || "id" };
      });
    }
    modelToTable[modelName] = tableName;
    tables.push({ name: tableName, modelName, columns: cols, file, line: start, source: "prisma", indexes });
    i++;
  }
  // Resolve FK target model names → table names
  for (const t of tables) for (const c of t.columns) if (c.references && modelToTable[c.references.table]) c.references.table = modelToTable[c.references.table];
  return { tables, modelToTable, enums };
}

export const prismaExtractor: Extractor = {
  name: "prisma",
  applies: (det, files) => det.orms.includes("prisma") || files.some((f) => f.rel.endsWith("schema.prisma")),
  async run(ctx) {
    const tables: TableFact[] = [];
    for (const f of ctx.files.filter((x) => x.rel.endsWith(".prisma"))) {
      try {
        const r = parsePrismaSchema(await ctx.read(f.rel), f.rel);
        tables.push(...r.tables);
        ctx.log(`prisma: ${r.tables.length} models in ${f.rel}`);
      } catch (e) { ctx.log(`prisma: failed ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    return { tables };
  },
};
