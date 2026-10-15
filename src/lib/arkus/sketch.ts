// A page "sketch": what a screen looks like, read from the graph alone (fields, bindings, the APIs it
// calls and the tables behind them). No code runs, so it works for every project, local or cloud.
// Deterministic and cheap: a few passes over edges, no I/O.
import type { GBinding, GNode, Graph } from "./types";

export type SketchField = { label: string; uiType: string; required: boolean; savedTo?: string; via?: string };
export type SketchSection =
  | { kind: "form"; fields: SketchField[]; submit?: { label: string; api?: string } }
  | { kind: "list"; title: string; source: string; table?: string }
  | { kind: "text"; title: string };
export type SketchCall = { key: string; method: string; path: string; tables: string[] };
export type PageSketch = { key: string; path: string; name: string; kind: "page" | "component"; file?: string; header: { title: string }; sections: SketchSection[]; calls: SketchCall[]; links: string[] };

type ScreenField = { label: string; name?: string; uiType: string; required?: boolean };

/** Route path of a screen node ("/register"). */
export const screenPath = (n: GNode): string => String(n.attrs?.path || n.key.replace(/^screen:/, "") || n.name);
/** Fields the extractor found on a screen. */
export const screenFields = (n: GNode): ScreenField[] => (Array.isArray(n.attrs?.fields) ? (n.attrs.fields as ScreenField[]) : []).filter((f) => f && typeof f === "object");
/** A page with inputs is a form; anything else is a display page. */
export const isFormScreen = (n: GNode, bindings: GBinding[] = []): boolean => screenFields(n).length > 0 || bindings.some((b) => b.pageKey === n.key && b.kind === "input");
/** Group a page under its first path segment ("/resources/:id/edit" → "/resources"; "/" → "/"). */
export const screenGroup = (n: GNode): string => { const seg = screenPath(n).split("/").filter(Boolean)[0]; return seg && !seg.startsWith(":") ? `/${seg}` : "/"; };

export const epMethod = (n: GNode) => String(n.attrs?.method || n.name.split(" ")[0] || "GET").toUpperCase();
export const epPath = (n: GNode) => String(n.attrs?.path || n.name.replace(/^[A-Z]+\s+/, ""));
const epLabel = (n: GNode) => `${epMethod(n)} ${epPath(n)}`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const humanize = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "Sign in", "Sign up", "Reset password", "Search", "Create", "Save", "Delete" or "Submit". The page's own
 *  path is read first (a /register page signs up even when its bindings resolve elsewhere), then the API's. */
export function submitLabel(method?: string, apiPath?: string, pagePath?: string): string {
  for (const p of [pagePath || "", apiPath || ""].map((x) => x.toLowerCase())) {
    if (/log-?in|sign-?in|session/.test(p)) return "Sign in";
    if (/register|sign-?up/.test(p)) return "Sign up";
    if (/forgot|reset/.test(p)) return "Reset password";
    if (/search|ask|query/.test(p)) return "Search";
    if (/invite/.test(p)) return "Invite";
    if (/upload|import/.test(p)) return "Upload";
  }
  const m = (method || "").toUpperCase();
  if (m === "GET") return "Filter";
  if (m === "POST") return "Create";
  if (m === "PUT" || m === "PATCH") return "Save";
  if (m === "DELETE") return "Delete";
  return "Submit";
}

/** Title of a list section from the endpoint path: "/api/resources" → "Resources", "/api/projects/:id" → "Project". */
function listTitle(path: string): string {
  const parts = path.split("/").filter((s) => s && s !== "api" && !s.startsWith(":"));
  const last = parts[parts.length - 1] || "Items";
  const singular = /:[a-z]/i.test(path.split("/").slice(-1)[0] || "") && last.endsWith("s") ? last.slice(0, -1) : last;
  return humanize(singular);
}

export function buildSketch(graph: Graph, screenKey: string): PageSketch | null {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  const node = byKey.get(screenKey);
  if (!node || (node.type !== "screen" && node.type !== "component")) return null;
  const path = screenPath(node);

  // Endpoints this page calls: direct `calls` edges plus one hop through the components it renders.
  const callKeys = new Set<string>();
  const sources = [screenKey, ...graph.edges.filter((e) => e.from === screenKey && e.type === "renders").map((e) => e.to)];
  for (const e of graph.edges) if (e.type === "calls" && sources.includes(e.from) && e.to.startsWith("endpoint:") && byKey.has(e.to)) callKeys.add(e.to);
  const tablesOf = (epKey: string) => [...new Set(graph.edges.filter((e) => e.from === epKey && (e.type === "reads" || e.type === "writes") && e.to.startsWith("table:")).map((e) => byKey.get(e.to)?.name || e.to.slice(6)))].sort();
  const calls: SketchCall[] = [...callKeys].map((k) => { const n = byKey.get(k)!; return { key: k, method: epMethod(n), path: epPath(n), tables: tablesOf(k) }; })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  // Fields: the extractor's list, each matched to its binding (label, then body key, then a shared word).
  const inputs = graph.bindings.filter((b) => b.pageKey === screenKey && b.kind === "input");
  const used = new Set<GBinding>();
  const pick = (f: ScreenField): GBinding | undefined => {
    const tries: ((b: GBinding) => boolean)[] = [
      (b) => norm(b.fieldLabel) === norm(f.label),
      (b) => !!f.name && (b.keyName === f.name || norm(b.fieldLabel) === norm(f.name)),
      (b) => { const fw = words(f.label), bw = words(b.fieldLabel); return bw.length > 0 && bw.every((w) => fw.includes(w)); },
    ];
    for (const t of tries) { const hit = inputs.find((b) => !used.has(b) && t(b)); if (hit) { used.add(hit); return hit; } }
    return undefined;
  };
  const toField = (label: string, uiType: string, required: boolean, b?: GBinding): SketchField => {
    const ep = b?.apiKey ? byKey.get(b.apiKey) : undefined;
    return { label, uiType: uiType || "text", required, savedTo: b?.tableName && b?.columnName ? `${b.tableName}.${b.columnName}` : undefined, via: ep ? epLabel(ep) : undefined };
  };
  const fields: SketchField[] = screenFields(node).map((f) => toField(String(f.label || f.name || "Field"), String(f.uiType || "text"), !!f.required, pick(f)));
  for (const b of inputs) if (!used.has(b)) fields.push(toField(b.fieldLabel, b.uiType, false, b));

  const sections: SketchSection[] = [];
  if (fields.length) {
    // The form posts to the API most fields bind to, else the first non-GET call.
    const counts = new Map<string, number>();
    for (const f of fields) if (f.via) counts.set(f.via, (counts.get(f.via) || 0) + 1);
    const viaTop = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    const write = calls.find((c) => c.method !== "GET");
    const api = viaTop || (write ? `${write.method} ${write.path}` : undefined);
    const [m, p] = api ? [api.split(" ")[0], api.split(" ").slice(1).join(" ")] : [undefined, undefined];
    sections.push({ kind: "form", fields, submit: { label: submitLabel(m, p, path), api } });
  }
  // A list reads from the table named like its path when there is one ("/api/resources" → Resource), else the first.
  const tableFor = (c: SketchCall) => { const want = norm(listTitle(c.path)); return c.tables.find((t) => norm(t) === want) || c.tables.find((t) => norm(t).includes(want) || want.includes(norm(t))) || c.tables[0]; };
  for (const c of calls) if (c.method === "GET") sections.push({ kind: "list", title: listTitle(c.path), source: `${c.method} ${c.path}`, table: tableFor(c) });
  if (!sections.length) sections.push({ kind: "text", title: "Static content" });

  // Pages this one points at, if the graph has any screen → screen edge besides containment.
  const links = [...new Set(graph.edges.filter((e) => e.from === screenKey && e.type !== "contains" && e.to.startsWith("screen:") && e.to !== screenKey).map((e) => e.to))].sort();

  return { key: screenKey, path, name: node.name || path, kind: node.type === "component" ? "component" : "page", file: node.file, header: { title: node.name && node.name !== path ? node.name : humanize(path.split("/").filter((s) => s && !s.startsWith(":")).pop() || "Home") }, sections, calls, links };
}
