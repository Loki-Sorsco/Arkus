// SQL migrations → TableFact (source "sql"). Applies CREATE/ALTER/DROP TABLE + CREATE INDEX in filename order.
// Regex based on purpose: must never throw on an unsupported dialect.
import type { ExtractContext, Extractor, TableFact, ColumnFact, Facts } from "../types";
import { isSkipped, MAX_FILE_BYTES, safeRead, lineOfOffset } from "./util";

const MIGRATION_DIR = /(^|\/)(migrations?|migrate|db|database|sql|schema|supabase|drizzle|prisma\/migrations|flyway|liquibase|knex|seeds?)(\/|$)/i;
const MODIFIER = /^(PRIMARY|NOT|NULL|UNIQUE|DEFAULT|REFERENCES|CHECK|CONSTRAINT|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|COLLATE|COMMENT|ON|IDENTITY|UNSIGNED|CHARACTER|ENCODE|DISTKEY|SORTKEY)$/i;
const unq = (s: string) => s.trim().replace(/^[`"\[]|[`"\]]$/g, "").split(".").pop()!.replace(/^[`"\[]|[`"\]]$/g, "");

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}
/** split on top-level commas */
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "", q: string | null = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; cur += ch; continue; }
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
/** body between the first "(" after `from` and its matching ")" */
function parenBody(s: string, from: number): { body: string; end: number } | undefined {
  const start = s.indexOf("(", from); if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++; else if (s[i] === ")") { depth--; if (depth === 0) return { body: s.slice(start + 1, i), end: i + 1 }; }
  }
  return undefined;
}

function parseColumn(def: string): ColumnFact | undefined {
  const m = /^(`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+)\s+([\s\S]+)$/.exec(def.trim());
  if (!m) return undefined;
  const name = unq(m[1]);
  const rest = m[2].trim();
  const toks = rest.match(/\w+(?:\([^)]*\))?|'[^']*'|\S/g) ?? [];
  const typeToks: string[] = [];
  let i = 0;
  while (i < toks.length && !MODIFIER.test(toks[i].replace(/\(.*$/, ""))) typeToks.push(toks[i++]);
  if (!typeToks.length) return undefined;
  let type = typeToks.join(" ").toLowerCase();
  const col: ColumnFact = { name, type };
  if (/^(serial|bigserial|smallserial)$/.test(type)) { col.default = "autoincrement"; type = type === "serial" ? "integer" : type === "bigserial" ? "bigint" : "smallint"; col.type = type; }
  if (/\bPRIMARY\s+KEY\b/i.test(rest)) { col.pk = true; col.nullable = false; }
  if (/\bNOT\s+NULL\b/i.test(rest)) col.nullable = false; else if (!col.pk) col.nullable = true;
  if (/\bUNIQUE\b/i.test(rest)) col.unique = true;
  if (/\b(AUTO_INCREMENT|AUTOINCREMENT|GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY)\b/i.test(rest)) col.default = "autoincrement";
  const d = /\bDEFAULT\s+((?:'[^']*')|(?:\w+(?:\([^)]*\))?)|[^\s,]+)/i.exec(rest); if (d) col.default = d[1].replace(/^'|'$/g, "");
  const r = /\bREFERENCES\s+((?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?\w+[`"\]]?)\s*(?:\(\s*([`"\[]?\w+[`"\]]?)\s*\))?/i.exec(rest); if (r) col.references = { table: unq(r[1]), column: r[2] ? unq(r[2]) : "id" };
  return col;
}

function applyConstraint(t: TableFact, def: string) {
  const pk = /\bPRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(def);
  if (pk) for (const c of pk[1].split(",")) { const col = t.columns.find((x) => x.name === unq(c)); if (col) { col.pk = true; col.nullable = false; } }
  const fk = /\bFOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+((?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?\w+[`"\]]?)\s*(?:\(([^)]+)\))?/i.exec(def);
  if (fk) { const cols = fk[1].split(",").map(unq); const refCols = fk[3] ? fk[3].split(",").map(unq) : ["id"]; cols.forEach((c, i) => { const col = t.columns.find((x) => x.name === c); if (col) col.references = { table: unq(fk[2]), column: refCols[i] ?? refCols[0] }; }); }
  const uq = /\bUNIQUE\s*(?:KEY|INDEX)?\s*\w*\s*\(([^)]+)\)/i.exec(def);
  if (uq && !pk) { const cols = uq[1].split(",").map(unq); if (cols.length === 1) { const col = t.columns.find((x) => x.name === cols[0]); if (col) col.unique = true; } (t.indexes ??= []).push({ columns: cols, unique: true }); }
  const ix = /^(?:KEY|INDEX)\s+\w+\s*\(([^)]+)\)/i.exec(def);
  if (ix) { const cols = ix[1].split(",").map(unq); (t.indexes ??= []).push({ columns: cols }); for (const c of cols) { const col = t.columns.find((x) => x.name === c); if (col) col.index = true; } }
}

export function applySql(sql: string, file: string, tables: Map<string, TableFact>, log?: (m: string) => void) {
  const text = stripComments(sql);
  const stmtRe = /\b(CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNLOGGED\s+)?TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = stmtRe.exec(text))) {
    const kind = m[1].toUpperCase().replace(/\s+/g, " ");
    const at = m.index;
    const line = lineOfOffset(text, at);
    try {
      if (kind.startsWith("CREATE") && kind.endsWith("TABLE")) {
        const head = /^\s*(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?\w+[`"\]]?)/i.exec(text.slice(at + m[0].length));
        const pb = parenBody(text, at + m[0].length);
        if (!head || !pb) continue;
        const name = unq(head[1]);
        const t: TableFact = { name, columns: [], file, line, source: "sql" };
        const constraints: string[] = [];
        for (const def of splitTop(pb.body)) {
          if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|KEY|INDEX|CHECK|EXCLUDE|FULLTEXT|SPATIAL)\b/i.test(def)) { constraints.push(def); continue; }
          if (/^LIKE\b/i.test(def)) continue;
          const col = parseColumn(def); if (col) t.columns.push(col);
        }
        for (const c of constraints) applyConstraint(t, c);
        tables.set(name, t);
        stmtRe.lastIndex = pb.end;
      } else if (kind === "ALTER TABLE") {
        const seg = text.slice(at, (() => { const i = text.indexOf(";", at); return i < 0 ? text.length : i; })());
        const head = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?((?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?\w+[`"\]]?)/i.exec(seg); if (!head) continue;
        const name = unq(head[1]);
        const t = tables.get(name) ?? (() => { const nt: TableFact = { name, columns: [], file, line, source: "sql" }; tables.set(name, nt); return nt; })();
        const actions = splitTop(seg.slice(head.index + head[0].length));
        for (const a of actions) {
          let am: RegExpExecArray | null;
          if ((am = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|INDEX|KEY|CHECK)([\s\S]+)$/i.exec(a))) { const col = parseColumn(am[1]); if (col && !t.columns.some((c) => c.name === col.name)) t.columns.push(col); }
          else if ((am = /^ADD\s+([\s\S]+)$/i.exec(a))) applyConstraint(t, am[1]);
          else if ((am = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([`"\[]?\w+[`"\]]?)$/i.exec(a))) t.columns = t.columns.filter((c) => c.name !== unq(am![1]));
          else if ((am = /^RENAME\s+(?:COLUMN\s+)?([`"\[]?\w+[`"\]]?)\s+TO\s+([`"\[]?\w+[`"\]]?)/i.exec(a))) { const c = t.columns.find((x) => x.name === unq(am![1])); if (c) c.name = unq(am[2]); }
          else if ((am = /^RENAME\s+TO\s+([`"\[]?\w+[`"\]]?)/i.exec(a))) { tables.delete(name); t.name = unq(am[1]); tables.set(t.name, t); }
          else if ((am = /^(?:ALTER|MODIFY|CHANGE)\s+(?:COLUMN\s+)?([`"\[]?\w+[`"\]]?)\s+(?:(?:SET\s+DATA\s+)?TYPE\s+)?([\s\S]+)$/i.exec(a))) {
            const c = t.columns.find((x) => x.name === unq(am![1])); if (!c) continue;
            const rest = am[2];
            if (/^SET\s+NOT\s+NULL/i.test(rest)) c.nullable = false; else if (/^DROP\s+NOT\s+NULL/i.test(rest)) c.nullable = true;
            else if (/^SET\s+DEFAULT\s+/i.test(rest)) c.default = rest.replace(/^SET\s+DEFAULT\s+/i, "").replace(/^'|'$/g, "");
            else if (/^DROP\s+DEFAULT/i.test(rest)) delete c.default;
            else { const nc = parseColumn(`${c.name} ${rest}`); if (nc) Object.assign(c, { type: nc.type }); }
          }
        }
      } else if (kind === "DROP TABLE") {
        const d = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)/i.exec(text.slice(at)); if (!d) continue;
        for (const n of d[1].split(",")) tables.delete(unq(n.replace(/\s+(CASCADE|RESTRICT)\b.*$/i, "")));
      } else if (kind.startsWith("CREATE") && kind.endsWith("INDEX")) {
        const ix = /INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?\w+[`"\]]?)?\s*ON\s+(?:ONLY\s+)?((?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?\w+[`"\]]?)\s*(?:USING\s+\w+\s*)?\(([^)]+)\)/i.exec(text.slice(at)); if (!ix) continue;
        const t = tables.get(unq(ix[2])); if (!t) continue;
        const cols = ix[3].split(",").map((c) => unq(c.replace(/\s+(ASC|DESC)\b.*$/i, "").replace(/\(.*$/, "")));
        const unique = /UNIQUE/i.test(kind);
        (t.indexes ??= []).push({ name: ix[1] ? unq(ix[1]) : undefined, columns: cols, unique: unique || undefined });
        for (const c of cols) { const col = t.columns.find((x) => x.name === c); if (col) { col.index = true; if (unique && cols.length === 1) col.unique = true; } }
      }
    } catch (e) { log?.(`sql-migrations: statement at ${file}:${line} skipped: ${(e as Error).message}`); }
  }
}

export const sqlMigrationsExtractor: Extractor = {
  name: "sql-migrations",
  applies(_det, files) { return files.some((f) => f.rel.endsWith(".sql") && !isSkipped(f.rel)); },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const sqlFiles = ctx.files.filter((f) => f.rel.endsWith(".sql") && !isSkipped(f.rel) && f.size <= MAX_FILE_BYTES && !/(^|\/)(seeds?|fixtures?|data)\//i.test(f.rel) && !/(down|rollback|undo)\.sql$/i.test(f.rel) && !/(^|\/)down\//i.test(f.rel));
    const preferred = sqlFiles.filter((f) => MIGRATION_DIR.test(f.rel) || /schema|migration/i.test(f.rel));
    const chosen = (preferred.length ? preferred : sqlFiles).sort((a, b) => a.rel.localeCompare(b.rel));
    const tables = new Map<string, TableFact>();
    for (const f of chosen) {
      const text = await safeRead(ctx, f.rel); if (text === undefined) continue;
      try { applySql(text, f.rel, tables, (m) => ctx.log(m, "warn")); } catch (e) { ctx.log(`sql-migrations: failed on ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    const out = [...tables.values()].filter((t) => !/^(_prisma_migrations|schema_migrations|knex_migrations|migrations|flyway_schema_history|__drizzle_migrations)$/i.test(t.name));
    ctx.log(`sql-migrations: ${out.length} tables from ${chosen.length} files`);
    return { tables: out };
  },
};
