// Shared graph vocabulary. Every extractor emits Facts; the resolver turns Facts into a Graph
// (nodes + edges + bindings). Keys are stable strings so snapshots can be diffed.

export type NodeType =
  | "app" | "screen" | "component" | "apicall" | "endpoint" | "service"
  | "table" | "column" | "external" | "queue" | "job";

export type EdgeType =
  | "contains" | "calls" | "reads" | "writes" | "references" | "publishes" | "consumes" | "renders";

export type Evidence = { kind: "static" | "openapi" | "runtime" | "manual" | "designed" | "inferred"; file?: string; line?: number; note?: string };

export interface GNode {
  type: NodeType;
  key: string;          // e.g. "endpoint:GET /orders/:id" · "table:users" · "screen:/checkout" · "column:users.email"
  name: string;
  attrs?: Record<string, unknown>;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  confidence?: number;  // 0..1, default 1
  evidence?: Evidence[];
}

export interface GEdge {
  from: string;
  to: string;
  type: EdgeType;
  confidence?: number;
  evidence?: Evidence[];
}

export interface GBinding {
  pageKey: string;      // screen key
  fieldLabel: string;   // "Email"
  uiType: string;       // text | email | password | number | date | select | checkbox | hidden
  apiKey?: string;      // endpoint key
  keyName?: string;     // request body key ("email")
  keyType?: string;     // string · number · boolean
  tableName?: string;
  columnName?: string;
  colType?: string;
  kind: "input" | "server" | "computed" | "frontend_only";
  source: "static" | "runtime" | "designed" | "manual";
  confidence: number;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  bindings: GBinding[];
  unresolved: Unresolved[];
}

/** Things the analysis could not settle; shown as ⚠ chips for the user to confirm. */
export interface Unresolved {
  kind: "apicall_no_endpoint" | "endpoint_no_tables" | "dynamic_url" | "unknown_framework" | "secret_in_repo" | "table_no_model";
  key?: string;
  file?: string;
  line?: number;
  message: string;
}

// ---------------- Raw facts emitted by extractors ----------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY";

export interface RouteFact {
  method: HttpMethod;
  path: string;             // normalized: "/orders/:id"
  framework: string;        // nextjs-app | nextjs-pages | express | fastify | hono | nestjs | trpc | fastapi | flask | django | openapi
  file: string;
  line?: number;
  lineEnd?: number;
  handlerName?: string;
  auth?: boolean | "unknown";
  bodyKeys?: { name: string; type?: string; required?: boolean; validation?: string }[];
  responseKeys?: { name: string; type?: string }[];
  tablesRead?: string[];    // from ORM/SQL usage inside the handler file
  tablesWritten?: string[];
  description?: string;     // from openapi summary / docstring
  confidence?: number;
  evidence?: Evidence[];
}

export interface ScreenFact {
  path: string;             // "/checkout"
  name: string;
  file: string;
  kind: "page" | "component";
  fields?: { label: string; name?: string; uiType: string; required?: boolean; line?: number }[];
  componentsUsed?: string[];
}

export interface ApiCallFact {
  fromFile: string;         // file containing the call (screen/component/hook)
  method: HttpMethod;
  path: string;             // may contain :param or ${...} placeholders
  line?: number;
  dynamic?: boolean;        // url built at runtime
  bodyKeys?: string[];
  lib: string;              // fetch | axios | react-query | swr | trpc | server-action
}

export interface ColumnFact {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  unique?: boolean;
  default?: string;
  references?: { table: string; column: string };
  index?: boolean;
}

export interface TableFact {
  name: string;             // db table name (snake_case where known)
  modelName?: string;       // ORM model name ("User")
  columns: ColumnFact[];
  file?: string;
  line?: number;
  source: "prisma" | "drizzle" | "typeorm" | "sequelize" | "mongoose" | "sqlalchemy" | "django" | "sql" | "introspection" | "designed";
  rowEstimate?: number;
  indexes?: { name?: string; columns: string[]; unique?: boolean }[];
}

export interface OrmUsageFact {
  file: string;
  table: string;            // resolved table name
  op: "read" | "write";
  line?: number;
  via: "prisma" | "drizzle" | "sql" | "sqlalchemy" | "django" | "mongoose" | "typeorm" | "knex";
}

export interface ExternalFact {
  name: string;             // stripe | sendgrid | s3 | openai ...
  file: string;
  evidence: string;         // import name or env var
}

export interface Facts {
  routes: RouteFact[];
  screens: ScreenFact[];
  apicalls: ApiCallFact[];
  tables: TableFact[];
  ormUsage: OrmUsageFact[];
  externals: ExternalFact[];
  unresolved: Unresolved[];
}

export const emptyFacts = (): Facts => ({ routes: [], screens: [], apicalls: [], tables: [], ormUsage: [], externals: [], unresolved: [] });

export interface RepoFile {
  rel: string;              // posix relative path
  abs: string;
  size: number;
  ext: string;
}

export interface Detected {
  languages: string[];              // ts, js, py, go...
  frameworks: string[];             // nextjs, express, nestjs, fastify, hono, fastapi, flask, django, react, vue
  orms: string[];                   // prisma, drizzle, typeorm, sequelize, mongoose, sqlalchemy, django-orm, knex
  packageManager?: string;
  monorepo?: { tool: string; packages: string[] };
  apps: { name: string; dir: string; role: "frontend" | "backend" | "fullstack" | "library" | "unknown" }[];
  dbEngineHint?: string;            // from prisma datasource / DATABASE_URL name (never the value)
  summary: string;                  // "Next.js 16 · Prisma · SQLite"
}

export interface Extractor {
  name: string;
  /** cheap test on the detected stack + file list */
  applies(det: Detected, files: RepoFile[]): boolean;
  /** read files it cares about and emit facts */
  run(ctx: ExtractContext): Promise<Partial<Facts>>;
}

export interface ExtractContext {
  root: string;
  files: RepoFile[];
  det: Detected;
  read(rel: string): Promise<string>;      // scrubbed content (secrets redacted), cached
  log(msg: string, level?: "info" | "warn" | "error"): void;
}

export const nodeKey = {
  endpoint: (m: string, p: string) => `endpoint:${m.toUpperCase()} ${p}`,
  screen: (p: string) => `screen:${p}`,
  component: (f: string) => `component:${f}`,
  apicall: (fromFile: string, m: string, p: string) => `apicall:${fromFile}#${m.toUpperCase()} ${p}`,
  table: (t: string) => `table:${t}`,
  column: (t: string, c: string) => `column:${t}.${c}`,
  external: (n: string) => `external:${n}`,
  service: (n: string) => `service:${n}`,
  app: (n: string) => `app:${n}`,
};

/** "/orders/[id]" · "/orders/{id}" · "/orders/<int:id>" · "/orders/:id" → "/orders/:id" */
export function normalizePath(p: string): string {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  s = s.replace(/\[\.\.\.([^\]]+)\]/g, ":$1*").replace(/\[\[\.\.\.([^\]]+)\]\]/g, ":$1*");
  s = s.replace(/\[([^\]]+)\]/g, ":$1");
  s = s.replace(/\{([^}]+)\}/g, ":$1");
  s = s.replace(/<(?:[a-z]+:)?([^>]+)>/g, ":$1");
  s = s.replace(/\$\{[^}]*\}/g, ":param");
  s = s.replace(/\(([^)]+)\)\//g, "/"); // next.js route groups "(marketing)/"
  s = s.replace(/\/\([^)]+\)$/g, "");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s || "/";
}
