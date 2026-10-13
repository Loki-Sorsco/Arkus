// Blueprint: the Architect's output. Zod-validated (the LLM is untrusted), convertible to a Graph.
import { z } from "zod";
import type { Graph, GNode, GEdge, GBinding } from "../types";
import { nodeKey, normalizePath } from "../types";

export const COLUMN_TYPES = ["text", "integer", "numeric", "boolean", "timestamptz", "uuid", "jsonb", "date"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const PAGE_KINDS = ["form", "display", "list", "auth"] as const;

const snake = z.string().min(1).max(64).transform((s) => toSnake(s));
const str = z.string().min(1).max(200);
const optStr = z.string().max(2000).optional();

export const ColumnSchema = z.object({
  name: snake,
  type: z.string().default("text").transform(normalizeColType),
  nullable: z.boolean().default(false),
  pk: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.string().max(200).optional(),
  references: z.object({ table: snake, column: snake }).optional(),
});

export const EntitySchema = z.object({
  name: str,
  table: snake,
  description: optStr.default(""),
  columns: z.array(ColumnSchema).min(1),
  indexes: z.array(z.object({ columns: z.array(snake).min(1), unique: z.boolean().optional() })).optional(),
});

export const RequestKeySchema = z.object({
  key: snake,
  type: z.string().default("string"),
  required: z.boolean().default(true),
  validation: optStr,
  fromField: optStr,
});

export const EndpointSchema = z.object({
  method: z.string().transform((m) => m.toUpperCase()).pipe(z.enum(HTTP_METHODS)),
  path: z.string().min(1).transform(normalizePath),
  name: str,
  description: optStr.default(""),
  auth: z.boolean().default(true),
  internal: z.boolean().optional(),
  request: z.array(RequestKeySchema).default([]),
  response: z.array(z.object({ key: z.string().min(1), type: z.string().default("string") })).default([]),
  reads: z.array(snake).default([]),
  writes: z.array(snake).default([]),
});

export const PageFieldSchema = z.object({
  label: str,
  key: snake,
  uiType: z.string().default("text"),
  required: z.boolean().default(false),
  endpoint: optStr,          // "POST /x"
  column: optStr,            // "users.email"
});

export const PageSchema = z.object({
  path: z.string().min(1).transform(normalizePath),
  name: str,
  kind: z.enum(PAGE_KINDS).default("display"),
  fields: z.array(PageFieldSchema).default([]),
  calls: z.array(z.string().min(1).transform(normalizeCallRef)).default([]),
});

export const BlueprintSchema = z.object({
  name: str,
  summary: z.string().max(4000).default(""),
  stack: z.object({
    frontend: str,
    backend: str,
    database: str,
    auth: str,
    payments: optStr,
    hosting: str,
    reasons: z.array(z.string().max(500)).default([]),
  }),
  entities: z.array(EntitySchema).min(1),
  endpoints: z.array(EndpointSchema).default([]),
  pages: z.array(PageSchema).default([]),
  services: z.array(z.object({ name: str, purpose: z.string().max(500).default("") })).default([]),
  jobs: z.array(z.object({ name: str, schedule: str, purpose: z.string().max(500).default("") })).optional(),
  assumptions: z.array(z.object({ id: snake, text: z.string().min(1).max(500), alternative: z.string().max(500).default(""), chosen: z.boolean().default(true) })).default([]),
  checks: z.array(z.object({ name: str, ok: z.boolean(), detail: z.string().max(1000).default("") })).default([]),
});

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type BlueprintInput = z.input<typeof BlueprintSchema>;
export type Entity = Blueprint["entities"][number];
export type Column = Entity["columns"][number];
export type Endpoint = Blueprint["endpoints"][number];
export type Page = Blueprint["pages"][number];
export type PageField = Page["fields"][number];
export type Check = Blueprint["checks"][number];

// ---------------- helpers ----------------

export function toSnake(s: string): string {
  return s.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "x";
}

export function normalizeColType(t: string): ColumnType {
  const s = (t || "").toLowerCase().trim();
  if ((COLUMN_TYPES as readonly string[]).includes(s)) return s as ColumnType;
  if (/uuid|guid/.test(s)) return "uuid";
  if (/int|serial|bigint|smallint/.test(s)) return "integer";
  if (/numeric|decimal|float|double|real|money|number/.test(s)) return "numeric";
  if (/bool/.test(s)) return "boolean";
  if (/timestamp|datetime/.test(s)) return "timestamptz";
  if (/^date$/.test(s)) return "date";
  if (/json/.test(s)) return "jsonb";
  return "text";
}

/** "post /bookings" · "POST  /bookings/" → "POST /bookings" */
export function normalizeCallRef(ref: string): string {
  const m = ref.trim().match(/^([a-zA-Z]+)\s+(\S+)$/);
  if (!m) return ref.trim();
  return `${m[1].toUpperCase()} ${normalizePath(m[2])}`;
}

export const endpointRef = (e: Pick<Endpoint, "method" | "path">) => `${e.method} ${e.path}`;
export const endpointKeyOf = (e: Pick<Endpoint, "method" | "path">) => nodeKey.endpoint(e.method, e.path);

export function parseCallRef(ref: string): { method: string; path: string } | null {
  const m = ref.match(/^([A-Z]+)\s+(\S+)$/);
  return m ? { method: m[1], path: m[2] } : null;
}

export function parseColumnRef(ref: string): { table: string; column: string } | null {
  const m = ref.match(/^([a-z0-9_]+)\.([a-z0-9_]+)$/);
  return m ? { table: m[1], column: m[2] } : null;
}

// ---------------- validation ----------------

export type Issue = { level: "error" | "warn"; where: string; message: string };

export function validateBlueprint(json: unknown): { blueprint: Blueprint | null; issues: Issue[] } {
  const parsed = BlueprintSchema.safeParse(json);
  if (!parsed.success) {
    const issues: Issue[] = parsed.error.issues.slice(0, 50).map((i) => ({ level: "error", where: i.path.join("."), message: i.message }));
    return { blueprint: null, issues };
  }
  const bp = parsed.data;
  const issues: Issue[] = [];
  const tables = new Map(bp.entities.map((e) => [e.table, e]));
  const eps = new Map(bp.endpoints.map((e) => [endpointRef(e), e]));

  const seenTables = new Set<string>();
  for (const e of bp.entities) {
    if (seenTables.has(e.table)) issues.push({ level: "error", where: `entities.${e.table}`, message: `duplicate table ${e.table}` });
    seenTables.add(e.table);
    const cols = new Set<string>();
    for (const c of e.columns) {
      if (cols.has(c.name)) issues.push({ level: "error", where: `entities.${e.table}.${c.name}`, message: "duplicate column" });
      cols.add(c.name);
      if (c.references) {
        const t = tables.get(c.references.table);
        if (!t) issues.push({ level: "error", where: `entities.${e.table}.${c.name}`, message: `FK target table ${c.references.table} does not exist` });
        else if (!t.columns.some((x) => x.name === c.references!.column))
          issues.push({ level: "error", where: `entities.${e.table}.${c.name}`, message: `FK target ${c.references.table}.${c.references.column} does not exist` });
      }
    }
    if (!e.columns.some((c) => c.pk)) issues.push({ level: "warn", where: `entities.${e.table}`, message: "no primary key" });
    for (const ix of e.indexes ?? []) for (const col of ix.columns)
      if (!cols.has(col)) issues.push({ level: "error", where: `entities.${e.table}.indexes`, message: `index column ${col} does not exist` });
  }
  const seenEps = new Set<string>();
  for (const ep of bp.endpoints) {
    const ref = endpointRef(ep);
    if (seenEps.has(ref)) issues.push({ level: "error", where: `endpoints.${ref}`, message: "duplicate endpoint" });
    seenEps.add(ref);
    for (const t of [...ep.reads, ...ep.writes])
      if (!tables.has(t)) issues.push({ level: "error", where: `endpoints.${ref}`, message: `table ${t} does not exist` });
  }
  for (const p of bp.pages) {
    for (const c of p.calls)
      if (!eps.has(c)) issues.push({ level: "error", where: `pages.${p.path}`, message: `calls unknown endpoint ${c}` });
    for (const f of p.fields) {
      if (f.endpoint && !eps.has(f.endpoint)) issues.push({ level: "error", where: `pages.${p.path}.${f.key}`, message: `bound to unknown endpoint ${f.endpoint}` });
      if (f.column) {
        const cr = parseColumnRef(f.column);
        const t = cr && tables.get(cr.table);
        if (!cr || !t || !t.columns.some((c) => c.name === cr.column))
          issues.push({ level: "error", where: `pages.${p.path}.${f.key}`, message: `bound to unknown column ${f.column}` });
      }
    }
  }
  return { blueprint: bp, issues };
}

// ---------------- graph conversion ----------------

export function blueprintToGraph(bp: Blueprint): Graph {
  const ev = [{ kind: "designed" as const, note: "architect blueprint" }];
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const bindings: GBinding[] = [];
  const seen = new Set<string>();
  const add = (n: GNode) => { if (!seen.has(n.key)) { seen.add(n.key); nodes.push({ confidence: 1, evidence: ev, ...n }); } };
  const edge = (from: string, to: string, type: GEdge["type"]) => {
    if (seen.has(from) && seen.has(to)) edges.push({ from, to, type, confidence: 1, evidence: ev });
  };

  add({ type: "app", key: nodeKey.app(bp.name), name: bp.name, attrs: { stack: bp.stack, summary: bp.summary } });

  for (const e of bp.entities) {
    const tk = nodeKey.table(e.table);
    add({ type: "table", key: tk, name: e.table, attrs: { modelName: e.name, description: e.description, source: "designed", columnCount: e.columns.length } });
    for (const c of e.columns) {
      add({ type: "column", key: nodeKey.column(e.table, c.name), name: c.name, attrs: { type: c.type, nullable: c.nullable, pk: !!c.pk, unique: !!c.unique, default: c.default, references: c.references } });
      edge(tk, nodeKey.column(e.table, c.name), "contains");
    }
  }
  for (const e of bp.entities) for (const c of e.columns)
    if (c.references) edge(nodeKey.column(e.table, c.name), nodeKey.column(c.references.table, c.references.column), "references");

  for (const ep of bp.endpoints) {
    const k = endpointKeyOf(ep);
    add({ type: "endpoint", key: k, name: ep.name, attrs: { method: ep.method, path: ep.path, auth: ep.auth, description: ep.description, bodyKeys: ep.request, responseKeys: ep.response, framework: "nextjs-app" } });
    for (const t of ep.reads) edge(k, nodeKey.table(t), "reads");
    for (const t of ep.writes) edge(k, nodeKey.table(t), "writes");
  }

  for (const s of bp.services) add({ type: "external", key: nodeKey.external(toSnake(s.name)), name: s.name, attrs: { purpose: s.purpose } });
  for (const jb of bp.jobs ?? []) add({ type: "job", key: `job:${toSnake(jb.name)}`, name: jb.name, attrs: { schedule: jb.schedule, purpose: jb.purpose } });

  const colTypeOf = (t: string, c: string) => bp.entities.find((e) => e.table === t)?.columns.find((x) => x.name === c)?.type;
  for (const p of bp.pages) {
    const sk = nodeKey.screen(p.path);
    add({ type: "screen", key: sk, name: p.name, attrs: { kind: p.kind, fields: p.fields.map((f) => ({ label: f.label, name: f.key, uiType: f.uiType, required: f.required })) } });
    edge(nodeKey.app(bp.name), sk, "contains");
    for (const c of p.calls) { const r = parseCallRef(c); if (r) edge(sk, nodeKey.endpoint(r.method, r.path), "calls"); }
    for (const f of p.fields) {
      const epRef = f.endpoint ?? p.calls.find((c) => c.startsWith("POST") || c.startsWith("PUT") || c.startsWith("PATCH")) ?? p.calls[0];
      const er = epRef ? parseCallRef(epRef) : null;
      const ep = er ? bp.endpoints.find((e) => e.method === er.method && e.path === er.path) : undefined;
      const reqKey = ep?.request.find((r) => r.key === f.key || r.fromField === f.key);
      const cr = f.column ? parseColumnRef(f.column) : null;
      bindings.push({
        pageKey: sk, fieldLabel: f.label, uiType: f.uiType,
        apiKey: ep ? endpointKeyOf(ep) : undefined,
        keyName: reqKey?.key ?? (ep ? f.key : undefined),
        keyType: reqKey?.type,
        tableName: cr?.table, columnName: cr?.column, colType: cr ? colTypeOf(cr.table, cr.column) : undefined,
        kind: f.uiType === "hidden" ? "server" : ep ? "input" : "frontend_only",
        source: "designed", confidence: 1,
      });
    }
  }
  return { nodes, edges, bindings, unresolved: [] };
}
