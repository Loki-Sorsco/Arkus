// New API generator: a form spec (method · path · purpose · table · fields …) becomes one route file in the
// project's own conventions. Template-first and deterministic (apigen-templates.ts); when AI is on the
// template is polished against an existing handler (apigen-ai.ts). Nothing here writes to disk: the
// route returns { path, content, notes } and creation goes through PUT /file with baseHash null.
import type { Grounding } from "./actions-grounding";
import { isSecretColumn } from "./browse";
import { renderPython, renderTs, type Adapter, type Db, type FieldKind, type Model } from "./apigen-templates";
import type { TableFact } from "./types";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];
export const PURPOSES = ["list", "get_one", "create", "update", "delete", "custom"] as const;
export type Purpose = (typeof PURPOSES)[number];
export type ApiSpec = { method: Method; path: string; purpose: Purpose; table?: string; fields?: string[]; filters?: string[]; orderBy?: { column: string; dir: "asc" | "desc" }; limit?: number; auth: boolean; description?: string };
export type Generated = { path: string; content: string; notes: string[] };
export type Flavor = "next-app" | "next-pages" | "express" | "fastapi";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PATH_RE = /^\/[A-Za-z0-9_\-./:*]*$/;
const idents = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && IDENT.test(s)).slice(0, 60) : []);

/** Validate a request body into an ApiSpec, or explain what is wrong. Secret-named columns are dropped. */
export function parseSpec(raw: unknown): ApiSpec | { error: string } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const method = String(b.method || "").toUpperCase() as Method;
  if (!METHODS.includes(method)) return { error: "Pick a method (GET, POST, PUT, PATCH or DELETE)" };
  const path = typeof b.path === "string" ? b.path.trim().replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1") : "";
  if (!path || !PATH_RE.test(path) || path.length > 200) return { error: "The path must start with / and use letters, digits, - _ . and :param segments" };
  const purpose = PURPOSES.includes(b.purpose as Purpose) ? (b.purpose as Purpose) : "custom";
  const table = typeof b.table === "string" && b.table.trim() && b.table.length <= 80 ? b.table.trim() : undefined;
  const ob = b.orderBy as { column?: unknown; dir?: unknown } | undefined;
  const orderBy = ob && typeof ob.column === "string" && IDENT.test(ob.column) && !isSecretColumn(ob.column) ? { column: ob.column, dir: ob.dir === "asc" ? "asc" as const : "desc" as const } : undefined;
  const limit = typeof b.limit === "number" && Number.isInteger(b.limit) && b.limit > 0 && b.limit <= 500 ? b.limit : undefined;
  const description = typeof b.description === "string" ? b.description.trim().slice(0, 300) : undefined;
  return { method, path, purpose, table, fields: idents(b.fields).filter((f) => !isSecretColumn(f)), filters: idents(b.filters).filter((f) => !isSecretColumn(f)), orderBy, limit, auth: b.auth === true, description: description || undefined };
}

export const flavorOf = (g: Grounding): Flavor => {
  const fw = (g.framework || (g.stack.frameworks || [])[0] || "").toLowerCase();
  if (fw === "nextjs-pages" || /(^|\/)pages\/api\//.test(g.apiDir || "")) return "next-pages";
  if (/^(express|fastify|hono|koa|nestjs|node)/.test(fw)) return "express";
  if (/^(fastapi|flask|django|python)/.test(fw)) return "fastapi";
  return "next-app";
};

const seg = (s: string) => s.replace(/^:(\w+)$/, "[$1]").replace(/^\*$/, "[...rest]");
const kebab = (p: string) => p.split("/").filter((s) => s && !s.startsWith(":") && s !== "*" && s !== "api").join("-").replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-") || "route";
const snake = (p: string) => kebab(p).replace(/-/g, "_");
/** Where the route file goes, following the detected API dir and the framework's conventions. */
export function routeFilePath(spec: ApiSpec, flavor: Flavor, g: Grounding): string {
  const sampleExt = g.sample?.file.endsWith(".js") ? "js" : "ts";
  const parts = spec.path.split("/").filter(Boolean);
  if (flavor === "next-app" || flavor === "next-pages") {
    const apiDir = g.apiDir && /\/api$/.test(g.apiDir) ? g.apiDir : flavor === "next-pages" ? "src/pages/api" : "src/app/api";
    const underApi = parts[0] === "api";
    const base = underApi ? apiDir : apiDir.replace(/\/api$/, "");
    const rest = (underApi ? parts.slice(1) : parts).map(seg);
    if (flavor === "next-pages") return [base, ...rest.slice(0, -1), `${rest[rest.length - 1] || "index"}.${sampleExt}`].join("/");
    return [base, ...rest, `route.${sampleExt}`].join("/");
  }
  if (flavor === "express") return `${g.apiDir && /(routes|routers|controllers)$/.test(g.apiDir) ? g.apiDir : "src/routes"}/${kebab(spec.path)}.${sampleExt}`;
  return `${g.apiDir && /(routers|routes|api)$/.test(g.apiDir) ? g.apiDir : "app/routers"}/${snake(spec.path)}.py`;
}

const findTable = (g: Grounding, name: string): TableFact | undefined => {
  const n = name.toLowerCase();
  return g.tables.find((t) => t.name.toLowerCase() === n) ?? g.tables.find((t) => (t.modelName || "").toLowerCase() === n) ?? g.tables.find((t) => t.name.toLowerCase().split(".").pop() === n);
};
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const camel = (s: string) => lowerFirst(s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(""));

const AUTH_FNS = ["requireUser", "requireAuth", "requireSession", "getServerSession", "getSession", "currentUser", "getCurrentUser", "getUser", "auth", "verifyToken", "requireDeveloper"];
/** How the sample handler checks who is calling, so new routes reuse the same helper. */
export function detectAuth(sample: string | null): { importLine: string; call: string; name: string } | { wrapper: string } | null {
  if (!sample) return null;
  const importLines = sample.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  for (const name of AUTH_FNS) {
    const line = importLines.find((l) => new RegExp(`[{,\\s]${name}[,\\s}]`).test(l));
    if (line && new RegExp(`\\b${name}\\s*\\(`).test(sample)) return { importLine: line.trim(), call: `${name}()`, name };
  }
  const w = /\b(withAuth|withSession|requireRole|protectedRoute)\s*\(/.exec(sample);
  return w ? { wrapper: w[1] } : null;
}
/** The database client the sample uses (import line + how it is called). */
export function detectDb(sample: string | null, g: Grounding): Db {
  const ph = (i: number) => ((g.engine || g.stack.dbEngineHint) === "mysql" ? "?" : `$${i}`);
  const orms = (g.stack.orms || []).map((o) => o.toLowerCase());
  const lines = (sample || "").split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  const prismaLine = lines.find((l) => /\bprisma\b/i.test(l) && !/@prisma\/client/.test(l)) || lines.find((l) => /PrismaClient/.test(l));
  if (prismaLine) return { kind: "prisma", importLine: prismaLine.trim(), client: /\bprisma\b/.test(prismaLine) ? "prisma" : "db", ph };
  const sqlLine = lines.find((l) => /\b(db|pool|sql|client|query)\b/.test(l) && /(["'])(?:@\/|\.{1,2}\/)[^"']*(db|database|pool|sql|pg|mysql)[^"']*\1/.test(l));
  if (sqlLine && sample && /\b(db|pool|client)\.query\(|\bsql`/.test(sample)) return { kind: "sql", importLine: sqlLine.trim(), client: /\bpool\b/.test(sqlLine) ? "pool" : /\bclient\b/.test(sqlLine) ? "client" : "db", ph };
  if (orms.includes("prisma")) return { kind: "prisma", importLine: 'import { prisma } from "@/lib/db";', client: "prisma", ph };
  if (orms.some((o) => /drizzle|knex|pg|mysql|sequelize|typeorm/.test(o))) return { kind: "sql", importLine: 'import { db } from "@/lib/db";', client: "db", ph };
  return { kind: "none", importLine: "", client: "db", ph };
}

/** Deterministic route file for the spec in the project's conventions, plus notes for the author. */
export function generateRoute(spec: ApiSpec, g: Grounding): Generated {
  const flavor = flavorOf(g);
  const path = routeFilePath(spec, flavor, g);
  const notes: string[] = [];
  if (!g.framework && !(g.stack.frameworks || []).length) notes.push("No API framework was detected; this follows Next.js App Router conventions.");
  const sample = g.sample?.content ?? null;
  const t = spec.table ? findTable(g, spec.table) : undefined;
  if (spec.table && !t) notes.push(`Table ${spec.table} is not in the map; column names were not checked.`);
  const cols = t?.columns.filter((c) => !isSecretColumn(c.name)) ?? [];
  const pkCol = t?.columns.find((c) => c.pk) ?? cols.find((c) => c.name === "id");
  const fields = (spec.fields?.length ? spec.fields : cols.map((c) => c.name)).filter((f) => !t || cols.some((c) => c.name === f));
  const filters = (spec.filters || []).filter((f) => !t || cols.some((c) => c.name === f));
  const param = [...spec.path.matchAll(/:(\w+)/g)].map((m) => m[1]).pop() || null;
  if ((spec.purpose === "get_one" || spec.purpose === "update" || spec.purpose === "delete") && !param) notes.push("This purpose needs a :param in the path (for example /api/items/:id); the handler reads `id` from the query string instead.");
  const kindOf = (name: string): FieldKind => { const ty = cols.find((c) => c.name === name)?.type.toLowerCase() || "string"; return /int|num|dec|float|double|real|serial|bigint/.test(ty) ? "number" : /bool/.test(ty) ? "boolean" : /date|time/.test(ty) ? "date" : "string"; };
  const model: Model = {
    name: t?.modelName || spec.table || "item", client: camel(t?.modelName || spec.table || "item"), table: t?.name || spec.table || "items",
    fields: fields.map((f) => { const c = cols.find((x) => x.name === f); return { name: f, kind: kindOf(f), required: !!c && c.nullable === false && !c.pk && c.default == null && !/at$/i.test(c.name) }; }),
    filters: filters.map((f) => ({ name: f, kind: kindOf(f) })),
    pk: pkCol?.name || "id", pkNumeric: /int|serial|num/.test(pkCol?.type.toLowerCase() || "int"),
    param, orderBy: spec.orderBy ?? (cols.some((c) => /^(createdAt|created_at)$/.test(c.name)) ? { column: cols.find((c) => /^(createdAt|created_at)$/.test(c.name))!.name, dir: "desc" } : undefined), limit: spec.limit ?? 50,
  };
  const auth = spec.auth ? detectAuth(sample) : null;
  if (spec.auth && !auth) notes.push("No auth helper was found in the existing handlers: a TODO block marks where to add the login check.");
  if (spec.auth && auth && "wrapper" in auth) notes.push(`Existing handlers are wrapped with ${auth.wrapper}(); the TODO block shows where to apply it (AI polish adapts this when AI is on).`);
  if (flavor === "fastapi") return { path, content: renderPython(spec, model, auth && "call" in auth ? auth : null), notes: [...notes, "Include the router in your app: app.include_router(router)."] };
  const db: Db = spec.table ? detectDb(sample, g) : { kind: "none", importLine: "", client: "db", ph: (i) => `$${i}` };
  if (spec.purpose !== "custom" && db.kind === "none") notes.push(spec.table ? "No database client was found in the existing handlers; the data access is a TODO." : "Pick a table to get a real database query; without one the data access is a TODO.");
  if (db.kind === "prisma" && !sample) notes.push(`Check the prisma import path (${db.importLine}).`);
  const usesNextResponse = !!sample && /NextResponse/.test(sample);
  const adapter: Adapter = flavor === "next-app"
    ? { flavor, q: (n) => `url.searchParams.get("${n}")`, param: (n) => `const { ${n} } = await ctx.params;`, body: "await req.json().catch(() => ({}))", json: (x, s) => (usesNextResponse ? `NextResponse.json(${x}${s ? `, { status: ${s} }` : ""})` : `Response.json(${x}${s ? `, { status: ${s} }` : ""})`), nextResponse: usesNextResponse }
    : flavor === "next-pages"
      ? { flavor, q: (n) => `(typeof req.query.${n} === "string" ? req.query.${n} : null)`, param: (n) => `const ${n} = String(req.query.${n} ?? "");`, body: "req.body ?? {}", json: (x, s) => `res.status(${s || 200}).json(${x})` }
      : { flavor, q: (n) => `(typeof req.query.${n} === "string" ? req.query.${n} : null)`, param: (n) => `const ${n} = req.params.${n};`, body: "req.body ?? {}", json: (x, s) => `res.status(${s || 200}).json(${x})` };
  const content = renderTs(spec, model, adapter, db, auth);
  if (flavor === "express") notes.push("Register the router where the other routes are mounted, for example app.use(router).");
  if (spec.purpose === "custom") notes.push("Custom purpose: the handler returns a placeholder; fill in the logic in the Code tab.");
  return { path, content, notes };
}

/** Does the file still define the handler for this method (used to validate AI output)? */
export function hasHandler(content: string, method: string, flavor: Flavor): boolean {
  const m = method.toUpperCase(), l = method.toLowerCase();
  if (flavor === "next-app") return new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${m}\\b|const\\s+${m}\\s*=|\\{[^}]*\\b${m}\\b[^}]*\\})`).test(content);
  if (flavor === "next-pages") return /export\s+default\b/.test(content);
  if (flavor === "express") return new RegExp(`\\.${l}\\s*\\(`).test(content) && /export\s+default|module\.exports|export\s+(const|function)/.test(content);
  return new RegExp(`@(?:router|app|api)\\.${l}\\s*\\(`).test(content);
}
