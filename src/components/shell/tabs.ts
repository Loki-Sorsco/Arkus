// Tab model for the editor shell. A tab is "a thing you opened": the map, a file, a table, an endpoint,
// a page, or one of the singleton tools (schema, query console, flows, plans, activity, connections,
// settings). Tabs live in one or two editor groups (split view) and persist per project.
import type { GNode } from "@/lib/arkus/types";

export type TabKind = "map" | "file" | "table" | "endpoint" | "page" | "request" | "schema" | "query" | "history" | "drift" | "ask" | "flows" | "plans" | "activity" | "connect" | "settings";
export type Tab = {
  id: string;
  kind: TabKind;
  /** graph key (table:users, endpoint:GET /x, screen:/y) or file path */
  key?: string;
  label: string;
  sub?: string;
  /** file tabs: line to reveal; node tabs: line of the symbol */
  line?: number;
  /** italic "preview" tab: replaced by the next preview open (single click); pinned by double click or edit */
  preview?: boolean;
  dirty?: boolean;
  params?: Record<string, string>;
};
export type TabsState = { groups: Tab[][]; active: (string | null)[]; focus: number };

/** Kinds that have exactly one tab regardless of key (the key is the current selection inside the tab). */
export const SINGLETON: readonly TabKind[] = ["map", "schema", "history", "drift", "ask", "flows", "plans", "activity", "connect", "settings"];
export const tabIdFor = (kind: TabKind, key?: string) => (SINGLETON.includes(kind) || !key ? kind : `${kind}:${key}`);
export const emptyTabs = (): TabsState => ({ groups: [[{ id: "map", kind: "map", label: "Map" }]], active: ["map"], focus: 0 });

export const KIND_LABEL: Record<TabKind, string> = { map: "Map", file: "File", table: "Table", endpoint: "API", page: "Page", request: "Request", schema: "Schema", query: "Query console", history: "Schema history", drift: "Drift", ask: "Ask", flows: "Flows", plans: "Plans", activity: "Activity", connect: "Connections", settings: "Settings" };

export const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
export const fileDir = (p: string) => { const parts = p.split(/[\\/]/); parts.pop(); return parts.join("/"); };

/** Which tab a graph node opens as. Columns open their table; components and api calls open their file. */
export function tabForNode(n: Pick<GNode, "key" | "type" | "name" | "file" | "lineStart" | "attrs">): Omit<Tab, "id"> | null {
  switch (n.type) {
    case "table": return { kind: "table", key: n.key, label: n.name };
    case "column": { const t = n.name.split(".")[0]; return { kind: "table", key: `table:${t}`, label: t, params: { column: n.name.split(".").slice(1).join(".") } }; }
    case "endpoint": return { kind: "endpoint", key: n.key, label: String(n.attrs?.path || n.name.replace(/^[A-Z]+\s+/, "")), sub: String(n.attrs?.method || ""), line: n.lineStart };
    case "screen": return { kind: "page", key: n.key, label: n.name, line: n.lineStart };
    case "component": case "apicall": return n.file ? { kind: "file", key: n.file, label: fileName(n.file), sub: fileDir(n.file), line: n.lineStart } : null;
    default: return null;
  }
}

/** URL that reflects a tab, so refresh and copy-link land on the same thing. */
export function routeForTab(slug: string, t: Tab): string {
  const base = `/p/${slug}`;
  const sel = t.key ? `?sel=${encodeURIComponent(t.key)}` : "";
  switch (t.kind) {
    case "map": return `${base}/overview`;
    case "table": return `${base}/database${sel}`;
    case "endpoint": return `${base}/apis${sel}`;
    case "page": return `${base}/pages${sel}`;
    case "file": return `${base}/files?path=${encodeURIComponent(t.key || "")}${t.line ? `&line=${t.line}` : ""}`;
    case "schema": return `${base}/database?tab=schema${t.key ? `&sel=${encodeURIComponent(t.key)}` : ""}`;
    case "query": return `${base}/database?tab=query${t.key ? `&id=${encodeURIComponent(t.key)}` : ""}`;
    case "request": return `${base}/requests${t.key ? `?id=${encodeURIComponent(t.key)}` : ""}`;
    case "history": return `${base}/database?tab=history`;
    case "drift": return `${base}/database?tab=drift`;
    case "flows": return `${base}/flows${t.key ? `?flow=${encodeURIComponent(t.key)}` : ""}`;
    case "plans": return `${base}/plans${t.key ? `?no=${encodeURIComponent(t.key)}` : ""}`;
    default: return `${base}/${t.kind}`;
  }
}
