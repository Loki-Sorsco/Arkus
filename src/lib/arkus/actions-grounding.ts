// Facts the action proposer is grounded in: the tables the request mentions (with columns and types),
// the endpoints it mentions (file paths + framework), one existing handler file as a style sample, and
// the project's stack / engine. Retrieval is deterministic (tokens from ask.ts); nothing here calls the
// model or the database. Source peeks are scrubbed of secrets.
import fs from "node:fs/promises";
import path from "node:path";
import { prisma, j } from "../db";
import { scrubSecrets, SECRET_FILE_RE } from "./fs";
import { loadGraph } from "./graph";
import { loadSchemaTables } from "./schemastore";
import { tokenize } from "./ask";
import type { Engine } from "./dbconn";
import type { ColumnFact, GNode, TableFact } from "./types";

export type Grounding = {
  project: { id: string; name: string; rootPath: string | null; repoUrl: string | null };
  stack: { summary?: string; frameworks?: string[]; orms?: string[]; dbEngineHint?: string };
  engine: Engine | null;
  hasSchema: boolean;
  /** Every table of the env's snapshot (falls back to the code graph's tables when no DB is connected). */
  tables: TableFact[];
  /** The tables / endpoints the request seems to be about, in rank order. */
  relevantTables: TableFact[];
  relevantEndpoints: GNode[];
  framework: string | null;
  sample: { file: string; content: string } | null;
  apiDir: string | null;
  context: string;
};

const SAMPLE_CHARS = 3200;
const MAX_TABLES = 6;
const MAX_ENDPOINTS = 6;

const score = (hay: string, tokens: string[]) => tokens.reduce((s, t, i) => (hay.includes(t) ? s + (hay === t ? 4 : 2) * (1 + Math.max(0, 0.5 - i * 0.05)) : s), 0);

function tableFromNode(n: GNode): TableFact {
  return { name: n.name, modelName: n.attrs?.modelName as string | undefined, columns: ((n.attrs?.columns as ColumnFact[]) || []), source: (n.attrs?.source as TableFact["source"]) || "introspection", rowEstimate: n.attrs?.rowEstimate as number | undefined, indexes: (n.attrs?.indexes as TableFact["indexes"]) || [], file: n.file };
}

async function peekFile(root: string, rel: string): Promise<string | null> {
  if (SECRET_FILE_RE.test(rel)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) return null;
  try {
    const text = scrubSecrets(await fs.readFile(abs, "utf8")).text;
    return text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) + "\n// … (truncated)" : text;
  } catch { return null; }
}

/** Most common directory the project's API route files live in (e.g. "src/app/api"). */
function apiDirOf(endpoints: GNode[]): string | null {
  const counts = new Map<string, number>();
  for (const e of endpoints) {
    const f = e.file || "";
    const m = /^(.*?\/api)\//.exec(f) || /^(.*?\/(?:routes|routers|controllers))\//.exec(f);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const colLine = (c: ColumnFact) => `${c.name} ${c.type}${c.pk ? " pk" : ""}${c.nullable === false ? " not-null" : ""}${c.unique ? " unique" : ""}${c.default != null && c.default !== "" ? ` default ${c.default}` : ""}${c.references ? ` -> ${c.references.table}.${c.references.column}` : ""}`;

export async function gatherGrounding(projectId: string, env: string, question: string): Promise<Grounding> {
  const [project, g, schema] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    loadGraph(projectId),
    loadSchemaTables(projectId, env),
  ]);
  const stack = j<Grounding["stack"]>(project.stack, {});
  const tokens = tokenize(question);
  const q = question.toLowerCase();

  const tables: TableFact[] = schema.tables.length ? schema.tables : g.nodes.filter((n) => n.type === "table").map(tableFromNode);
  const rankedTables = tables.map((t) => {
    const name = t.name.toLowerCase(); const model = (t.modelName || "").toLowerCase();
    let s = score(name, tokens) + score(model, tokens) + (new RegExp(`\\b${name.replace(/[^a-z0-9_]/g, "")}\\b`).test(q) ? 6 : 0) + (model && q.includes(model) ? 5 : 0);
    for (const c of t.columns) if (tokens.includes(c.name.toLowerCase())) s += 1;
    return { t, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.t);
  const relevantTables = rankedTables.slice(0, MAX_TABLES);

  const endpoints = g.nodes.filter((n) => n.type === "endpoint");
  const relevantEndpoints = endpoints.map((n) => {
    const p = String(n.attrs?.path || "").toLowerCase();
    const s = score(`${n.name.toLowerCase()} ${n.file || ""}`, tokens) + (p && q.includes(p) ? 6 : 0) + (relevantTables.some((t) => g.edges.some((e) => e.from === n.key && e.to === `table:${t.name}`)) ? 2 : 0);
    return { n, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, MAX_ENDPOINTS).map((x) => x.n);

  const framework = (relevantEndpoints[0]?.attrs?.framework as string | undefined) || (endpoints[0]?.attrs?.framework as string | undefined) || (stack.frameworks || [])[0] || null;
  // Style sample: the most relevant endpoint's handler, else any route file that writes a relevant table, else the first route.
  const candidates = [...relevantEndpoints, ...endpoints.filter((n) => relevantTables.some((t) => g.edges.some((e) => e.from === n.key && e.to === `table:${t.name}`))), ...endpoints].filter((n) => n.file);
  let sample: Grounding["sample"] = null;
  if (project.rootPath) for (const n of candidates.slice(0, 4)) { const c = await peekFile(project.rootPath, n.file!); if (c) { sample = { file: n.file!, content: c }; break; } }
  const apiDir = apiDirOf(endpoints);
  const engine = (schema.engine as Engine | undefined) ?? null;

  const lines: string[] = [];
  lines.push(`PROJECT ${project.name}: ${stack.summary || [...(stack.frameworks || []), ...(stack.orms || [])].join(", ") || "stack unknown"}. Framework for API routes: ${framework || "unknown"}.${apiDir ? ` API route files live under ${apiDir}/.` : ""}`);
  lines.push(schema.tables.length ? `DATABASE (${env}): ${engine || "unknown engine"}, ${schema.tables.length} tables in the live schema snapshot.` : `DATABASE: no database connected for env "${env}" (row and column actions are unavailable; only code changes can be applied).`);
  lines.push(`ALL TABLES: ${tables.map((t) => t.name).slice(0, 80).join(", ") || "none"}`);
  for (const t of relevantTables) lines.push(`TABLE ${t.name}${t.modelName && t.modelName !== t.name ? ` (model ${t.modelName})` : ""}${typeof t.rowEstimate === "number" ? ` · ~${t.rowEstimate} rows` : ""}\n  columns: ${t.columns.slice(0, 40).map(colLine).join("; ")}`);
  for (const n of relevantEndpoints) lines.push(`ENDPOINT ${n.name} · framework ${String(n.attrs?.framework || "?")} · file ${n.file || "?"}${n.attrs?.bodyKeys && (n.attrs.bodyKeys as unknown[]).length ? ` · body keys ${(n.attrs.bodyKeys as { name: string }[]).map((b) => b.name).join(", ")}` : ""}`);
  if (!relevantEndpoints.length && endpoints.length) lines.push(`OTHER ENDPOINTS (sample): ${endpoints.slice(0, 12).map((n) => `${n.name} (${n.file || "?"})`).join("; ")}`);
  if (sample) lines.push(`EXISTING HANDLER ${sample.file} (match its imports, helpers and style):\n${sample.content}`);

  return { project: { id: project.id, name: project.name, rootPath: project.rootPath, repoUrl: project.repoUrl }, stack, engine, hasSchema: schema.tables.length > 0, tables, relevantTables, relevantEndpoints, framework, sample, apiDir, context: scrubSecrets(lines.join("\n\n")).text };
}
