// Pure helpers for the Blueprint view: cross-column linking + inline-edit transforms.
// No React, no zod: safe to import from client components without pulling the server schema in.
import type { Blueprint, Check, Endpoint, Issue, Page } from "@/lib/arkus/architect/schema";

export type { Blueprint, Check, Endpoint, Issue, Page };
export type ProjectRef = { id: string; slug: string; name: string };
export type BlueprintResp = { blueprint: Blueprint; version: number; checks: Check[]; aiUsed: boolean; template?: string | null; issues: Issue[] };
export type BlueprintGet = { project: { id: string; name: string; mode: string }; blueprint: Blueprint | null; version: number; prompt: string | null; checks: Check[]; issues: Issue[]; versions: { version: number; createdAt: string }[] };

export const COLUMN_TYPES = ["text", "integer", "numeric", "boolean", "timestamptz", "uuid", "jsonb", "date"] as const;
export const UI_TYPES = ["text", "email", "password", "number", "textarea", "select", "checkbox", "date", "hidden"] as const;
export const EXPORTS = [["prisma", "Prisma schema", "schema.prisma"], ["sql", "SQL DDL", ".sql"], ["openapi", "OpenAPI", "openapi.json"], ["tasks", "Task list", "TASKS.md"], ["spec", "Full spec", ".blueprint.json"]] as const;

export const toSnake = (s: string) => s.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "x";
export const epRef = (e: Pick<Endpoint, "method" | "path">) => `${e.method} ${e.path}`;
export const normPath = (p: string) => { let s = p.trim().replace(/\s+/g, "-"); if (!s.startsWith("/")) s = "/" + s; if (s.length > 1) s = s.replace(/\/+$/, ""); return s; };

// ---------- hover linking ----------
/** Keys: `t:<table>` · `e:<METHOD /path>` · `p:<page path>` */
export const K = { t: (t: string) => `t:${t}`, e: (ref: string) => `e:${ref}`, p: (path: string) => `p:${path}` };

export function related(bp: Blueprint, key: string | null): Set<string> | null {
  if (!key) return null;
  const out = new Set<string>([key]);
  const epsOf = (p: Page) => new Set([...p.calls, ...p.fields.flatMap((f) => (f.endpoint ? [f.endpoint] : []))]);
  const [kind, id] = [key.slice(0, 1), key.slice(2)];
  if (kind === "t") {
    const eps = bp.endpoints.filter((e) => e.reads.includes(id) || e.writes.includes(id));
    const refs = new Set(eps.map(epRef));
    refs.forEach((r) => out.add(K.e(r)));
    bp.pages.forEach((p) => { if ([...epsOf(p)].some((c) => refs.has(c))) out.add(K.p(p.path)); });
  } else if (kind === "e") {
    const ep = bp.endpoints.find((e) => epRef(e) === id);
    ep?.reads.forEach((t) => out.add(K.t(t))); ep?.writes.forEach((t) => out.add(K.t(t)));
    bp.pages.forEach((p) => { if (epsOf(p).has(id)) out.add(K.p(p.path)); });
  } else if (kind === "p") {
    const page = bp.pages.find((p) => p.path === id);
    if (page) for (const ref of epsOf(page)) {
      out.add(K.e(ref));
      const ep = bp.endpoints.find((e) => epRef(e) === ref);
      ep?.reads.forEach((t) => out.add(K.t(t))); ep?.writes.forEach((t) => out.add(K.t(t)));
    }
  }
  return out;
}

/** Endpoints a page calls (calls + field bindings), in a stable order. */
export const pageEndpoints = (p: Page) => Array.from(new Set([...p.calls, ...p.fields.flatMap((f) => (f.endpoint ? [f.endpoint] : []))]));

/** Number of page fields that will become bindings in the stack graph (all fields are recorded; those with an endpoint are "input" bindings). */
export const bindingCount = (bp: Blueprint) => bp.pages.reduce((n, p) => n + p.fields.length, 0);

// ---------- inline edits (pure; the server re-validates via refine { blueprint }) ----------
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const replaceColRef = (ref: string | undefined, from: string, to: string) => (ref === from ? to : ref);

export function renameTable(bp: Blueprint, from: string, toRaw: string): Blueprint {
  const to = toSnake(toRaw); if (!to || to === from) return bp;
  const b = clone(bp);
  for (const e of b.entities) {
    if (e.table === from) { e.table = to; if (toSnake(e.name) === from) e.name = to; }
    for (const c of e.columns) if (c.references?.table === from) c.references.table = to;
  }
  for (const ep of b.endpoints) { ep.reads = ep.reads.map((t) => (t === from ? to : t)); ep.writes = ep.writes.map((t) => (t === from ? to : t)); }
  for (const p of b.pages) for (const f of p.fields) if (f.column?.startsWith(from + ".")) f.column = to + f.column.slice(from.length);
  return b;
}

export function renameColumn(bp: Blueprint, table: string, from: string, toRaw: string): Blueprint {
  const to = toSnake(toRaw); if (!to || to === from) return bp;
  const b = clone(bp);
  const ent = b.entities.find((e) => e.table === table); if (!ent) return bp;
  for (const c of ent.columns) if (c.name === from) c.name = to;
  for (const ix of ent.indexes ?? []) ix.columns = ix.columns.map((c) => (c === from ? to : c));
  for (const e of b.entities) for (const c of e.columns) if (c.references?.table === table && c.references.column === from) c.references.column = to;
  for (const p of b.pages) for (const f of p.fields) f.column = replaceColRef(f.column, `${table}.${from}`, `${table}.${to}`);
  return b;
}

export function addColumn(bp: Blueprint, table: string, nameRaw: string, type: string): Blueprint {
  const name = toSnake(nameRaw); if (!name) return bp;
  const b = clone(bp);
  const ent = b.entities.find((e) => e.table === table); if (!ent) return bp;
  ent.columns.push({ name, type: (COLUMN_TYPES as readonly string[]).includes(type) ? (type as Blueprint["entities"][number]["columns"][number]["type"]) : "text", nullable: true });
  return b;
}

export function deleteColumn(bp: Blueprint, table: string, name: string): Blueprint {
  const b = clone(bp);
  const ent = b.entities.find((e) => e.table === table); if (!ent) return bp;
  ent.columns = ent.columns.filter((c) => c.name !== name);
  for (const ix of ent.indexes ?? []) ix.columns = ix.columns.filter((c) => c !== name);
  ent.indexes = ent.indexes?.filter((ix) => ix.columns.length);
  for (const e of b.entities) for (const c of e.columns) if (c.references?.table === table && c.references.column === name) delete c.references;
  for (const p of b.pages) for (const f of p.fields) if (f.column === `${table}.${name}`) delete f.column;
  return b;
}

export function renameEndpointPath(bp: Blueprint, ref: string, toRaw: string): Blueprint {
  const b = clone(bp);
  const ep = b.endpoints.find((e) => epRef(e) === ref); if (!ep) return bp;
  const to = normPath(toRaw); if (to === ep.path) return bp;
  const newRef = `${ep.method} ${to}`;
  ep.path = to;
  for (const p of b.pages) { p.calls = p.calls.map((c) => (c === ref ? newRef : c)); for (const f of p.fields) if (f.endpoint === ref) f.endpoint = newRef; }
  return b;
}

export function addPageField(bp: Blueprint, pagePath: string, label: string, uiType: string): Blueprint {
  const b = clone(bp);
  const page = b.pages.find((p) => p.path === pagePath); if (!page || !label.trim()) return bp;
  const key = toSnake(label);
  const endpoint = page.calls.find((c) => /^(POST|PUT|PATCH)/.test(c));
  page.fields.push({ label: label.trim(), key, uiType, required: false, ...(endpoint ? { endpoint } : {}) });
  return b;
}

/** Derive a short project name from the idea sentence ("A gym class booking app with…" → "Gym Class Booking"). */
export function nameFromIdea(idea: string): string {
  const words = idea.trim().replace(/^(an?|the)\s+/i, "").split(/[\s,.;:!?]+/).filter(Boolean);
  const stop = new Set(["with", "where", "that", "which", "for", "to", "and", "so", "using", "built", "app", "application", "tool", "platform", "site", "website", "system", "service"]);
  const out: string[] = [];
  for (const w of words) { if (stop.has(w.toLowerCase()) && out.length) break; if (!stop.has(w.toLowerCase())) out.push(w[0].toUpperCase() + w.slice(1)); if (out.length >= 4) break; }
  return out.join(" ").slice(0, 60) || "New app";
}
