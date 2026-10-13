// Flows: the app as the things a user can do. Each flow is a left-to-right storyline
// page → endpoint(s) → tables (reads/writes) → external services, derived purely from the
// graph. Titles come from static heuristics (method + path + page); an optional single
// Groq call can polish titles/summaries, cached in Writeup under nodeKey `flow:<id>`.
import crypto from "node:crypto";
import { prisma, j } from "../db";
import { aiReady, chatJSON, untrusted } from "../llm";
import type { LoadedGraph } from "./graph";
import type { GBinding, GNode } from "./types";

export type FlowKind = "action" | "display" | "auth" | "admin";
export type FlowEndpoint = { key: string; name: string; method: string; path: string; title: string; writes: string[]; reads: string[]; externals: string[]; bodyKeys: string[]; auth?: boolean | "unknown"; file?: string; line?: number };
export type FlowStep = { plain: string; technical: string; kind: "page" | "api" | "result" };
export type FlowEvidence = { label: string; file: string; line?: number; screen?: "pages" | "apis"; sel?: string };
export type Flow = {
  id: string;
  title: string;
  kind: FlowKind;
  page: { key: string; name: string; label: string; file?: string };
  /** Other pages that trigger the same action (same endpoint). */
  alsoFrom: { key: string; name: string }[];
  endpoints: FlowEndpoint[];
  tables: { key: string; name: string; op: "writes" | "reads" }[];
  externals: { key: string; name: string }[];
  fields: { label: string; keyName?: string; column?: string }[];
  summary: string;
  steps: FlowStep[];
  evidence: FlowEvidence[];
  confidence: number;
  /** "ai" when title/summary came from the model, else "static". */
  source: "static" | "ai";
};

// ---------------------------------------------------------------- words

const HUMAN: Record<string, string> = { apikeys: "API keys", apikey: "API key", api_keys: "API keys", orgs: "organizations", org: "organization", me: "profile", auth: "account", oauth: "sign-in", cron: "scheduled jobs", webhooks: "webhooks", webhook: "webhook", url: "URL", urls: "URLs", id: "ID", ids: "IDs" };
const VERB_SEGS = new Set(["classify", "search", "import", "export", "seed", "check", "switch", "login", "logout", "signin", "signout", "register", "signup", "forgot", "reset", "verify", "send", "sync", "detect", "index", "command", "events", "callback", "health", "refresh", "publish", "archive", "restore", "duplicate", "invite", "join", "leave", "upload", "download", "run", "test", "analyze", "analyse", "generate", "summarize", "summarise", "ask", "chat", "complete", "approve", "reject", "cancel", "retry", "resend", "preview", "validate", "submit", "confirm"]);

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase();
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
export function singular(w: string): string {
  const l = w.toLowerCase();
  if (HUMAN[l]) return singular(HUMAN[l]);
  if (/(ss|us|is|data|media)$/.test(l) || l.length < 4) return w;
  if (/ies$/.test(l)) return w.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/.test(l)) return w.slice(0, -2);
  if (/s$/.test(l)) return w.slice(0, -1);
  return w;
}
export function plural(w: string): string {
  const l = w.toLowerCase();
  if (HUMAN[l]) return HUMAN[l];
  if (/(s|x|ch|sh)$/.test(l)) return /s$/.test(l) ? w : w + "es";
  if (/[^aeiou]y$/.test(l)) return w.slice(0, -1) + "ies";
  return w + "s";
}
const human = (seg: string) => HUMAN[seg.toLowerCase()] || words(seg);
const article = (w: string) => /^[aeiou]/i.test(w) && !/^(one|uni|use|eu)/i.test(w) ? "an" : "a";
const list = (xs: string[], max = 3) => { const u = [...new Set(xs)]; if (!u.length) return ""; const shown = u.slice(0, max); const rest = u.length - shown.length; if (rest > 0) return `${shown.join(", ")} and ${rest} more`; return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0]; };
/** "ApiKey" → "API keys", "User" → "Users". */
const tableLabel = (t: string) => { const ws = words(t.replace(/^table:/, "")).split(" ").map((w) => (w === "api" ? "API" : w)); ws[ws.length - 1] = plural(ws[ws.length - 1]); return cap(ws.join(" ")); };

/** Segments of an API path that carry meaning: no "api"/"v1", no :params. */
const meaningful = (p: string) => p.split("/").filter(Boolean).filter((s) => !s.startsWith(":") && !/^(api|v\d+|internal|rest)$/i.test(s));
const hasParam = (p: string) => p.split("/").some((s) => s.startsWith(":"));

/** Static title for one endpoint, with the page it is reached from as a hint. */
export function endpointTitle(method: string, path: string): string {
  const m = method.toUpperCase();
  const segs = meaningful(path);
  const last = (segs[segs.length - 1] || "").toLowerCase();
  const prev = segs.length > 1 ? segs[segs.length - 2].toLowerCase() : "";
  const resourceSeg = VERB_SEGS.has(last) ? prev : last;
  const res = resourceSeg ? human(resourceSeg) : "";
  const one = res ? singular(res) : "";
  const many = res ? plural(res) : "";
  const special: Record<string, string> = {
    register: "Sign up", signup: "Sign up", login: "Log in", signin: "Log in", logout: "Log out", signout: "Log out",
    forgot: "Request a password reset", reset: "Reset password", switch: "Switch workspace", profile: m === "GET" ? "View profile" : "Update profile",
    me: "Load the current user", settings: "Manage settings", search: "Search", seed: m === "DELETE" ? "Remove sample data" : "Load sample data",
    import: "Import data", export: "Export data", health: "Run health checks", google: "Sign in with Google", callback: "Finish Google sign-in", audit: "View the audit log",
    activity: "View activity", command: "Handle a Slack command", events: "Receive Slack events", github: "Receive GitHub webhooks", detect: "Detect links from the extension", index: "Sync the extension index",
  };
  if (last === "callback" && prev === "google") return "Finish Google sign-in";
  if (last === "google") return "Sign in with Google";
  if (last === "invites" || last === "invite") return m === "DELETE" ? "Revoke an invite" : m === "POST" ? "Invite a member" : m === "GET" ? "Browse invites" : "Update an invite";
  if (special[last] && (!VERB_SEGS.has(last) || !prev || prev === "auth" || prev === "extension" || prev === "slack" || prev === "integrations" || prev === "cron")) {
    if (last === "check" && one) return `Check ${article(one)} ${one}`;
    return special[last];
  }
  if (VERB_SEGS.has(last)) {
    const verb = cap(last);
    return one ? `${verb} ${article(one)} ${one}` : verb;
  }
  if (!res) return `${cap(m.toLowerCase())} ${path}`;
  if (m === "POST") return `Create ${article(one)} ${one}`;
  if (m === "PATCH" || m === "PUT") return `Update ${article(one)} ${one}`;
  if (m === "DELETE") return `Delete ${article(one)} ${one}`;
  if (m === "GET") return hasParam(path) ? `View ${article(one)} ${one}` : `Browse ${many}`;
  return `${cap(m.toLowerCase())} ${many}`;
}

/** Title for a display (read-only) flow, from the page path. */
export function pageFlowTitle(pagePath: string): string {
  const segs = pagePath.split("/").filter(Boolean);
  const named = segs.filter((s) => !s.startsWith(":"));
  if (!named.length) return "Visit the home page";
  const last = named[named.length - 1].toLowerCase();
  if (last === "dashboard") return "View the dashboard";
  if (last === "settings") return "View settings";
  if (last === "activity") return "View activity";
  if (last === "ask") return "Ask a question";
  if (last === "new") return `Open the new ${singular(human(named[named.length - 2] || "item"))} form`;
  if (last === "edit") return `Open the ${singular(human(named[named.length - 2] || "item"))} editor`;
  const res = human(last);
  return hasParam(pagePath) ? `View ${article(singular(res))} ${singular(res)}` : /s$/.test(last) ? `Browse ${plural(res)}` : `View ${res}`;
}

/** "/resources/:id/edit" → "Resource edit page"; "/projects/:id" → "Project page". */
export function pageLabel(pagePath: string): string {
  const segs = pagePath.split("/").filter(Boolean);
  if (!segs.filter((s) => !s.startsWith(":")).length) return "Home page";
  const parts: string[] = [];
  segs.forEach((s, i) => { if (s.startsWith(":")) return; const next = segs[i + 1]; const h = human(s); parts.push((next && (next.startsWith(":") || i < segs.length - 1)) && /s$/i.test(h) ? singular(h) : h); });
  return cap(parts.join(" ")) + " page";
}

const isAuthPath = (p: string) => /(^|\/)(auth|login|logout|register|signup|signin|signout|forgot|reset|password|session|oauth|sso)(\/|$)/i.test(p);
const isAdminPath = (p: string) => /(^|\/)(seed|cron|health|import|export|admin|apikeys|api-keys|integrations|webhooks|extension)(\/|$)/i.test(p);

// ---------------------------------------------------------------- derivation

type Ctx = { g: LoadedGraph; byKey: Map<string, GNode>; out: Map<string, GEdgeIdx[]>; inn: Map<string, GEdgeIdx[]> };
type GEdgeIdx = { from: string; to: string; type: string; confidence?: number; evidence?: { file?: string; line?: number }[] };

function index(g: LoadedGraph): Ctx {
  const byKey = new Map(g.nodes.map((n) => [n.key, n]));
  const out = new Map<string, GEdgeIdx[]>(); const inn = new Map<string, GEdgeIdx[]>();
  for (const e of g.edges) { (out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e); (inn.get(e.to) || inn.set(e.to, []).get(e.to)!).push(e); }
  return { g, byKey, out, inn };
}

/** Screens that reach an endpoint: direct `calls`, or via an apicall node the page `contains`/`calls`. */
function callersOf(c: Ctx, epKey: string): Map<string, { conf: number; apicall?: GNode }> {
  const m = new Map<string, { conf: number; apicall?: GNode }>();
  for (const e of c.inn.get(epKey) || []) {
    if (e.type !== "calls") continue;
    if (e.from.startsWith("screen:")) { const cur = m.get(e.from); m.set(e.from, { conf: Math.max(cur?.conf ?? 0, e.confidence ?? 1), apicall: cur?.apicall }); continue; }
    if (e.from.startsWith("apicall:")) {
      const ac = c.byKey.get(e.from);
      for (const up of c.inn.get(e.from) || []) if (up.from.startsWith("screen:") && (up.type === "contains" || up.type === "calls")) {
        const cur = m.get(up.from); m.set(up.from, { conf: Math.max(cur?.conf ?? 0, Math.min(e.confidence ?? 1, up.confidence ?? 1)), apicall: ac || cur?.apicall });
      }
    }
  }
  return m;
}

function endpointFacts(c: Ctx, ep: GNode, page: GNode | null, apicall?: GNode): FlowEndpoint {
  const method = String(ep.attrs?.method || "GET").toUpperCase();
  const path = String(ep.attrs?.path || ep.name.replace(/^[A-Z]+ /, ""));
  const edges = c.out.get(ep.key) || [];
  const writes = [...new Set(edges.filter((e) => e.type === "writes").map((e) => e.to.replace("table:", "")))];
  const reads = [...new Set(edges.filter((e) => e.type === "reads").map((e) => e.to.replace("table:", "")))].filter((t) => !writes.includes(t));
  const externals = [...new Set(edges.filter((e) => e.type === "calls" && e.to.startsWith("external:")).map((e) => e.to.replace("external:", "")))];
  const keys = new Set<string>();
  for (const b of (ep.attrs?.bodyKeys as { name: string }[] | undefined) || []) if (b?.name) keys.add(b.name);
  for (const k of (apicall?.attrs?.bodyKeys as string[] | undefined) || []) if (k) keys.add(k);
  for (const b of c.g.bindings) if (b.apiKey === ep.key && b.keyName) keys.add(b.keyName);
  return { key: ep.key, name: ep.name, method, path, title: endpointTitle(method, path), writes, reads, externals, bodyKeys: [...keys], auth: ep.attrs?.auth as boolean | "unknown" | undefined, file: ep.file, line: ep.lineStart };
}

/** How well a page fits as the home of an action on `ep`. */
function affinity(c: Ctx, page: GNode, ep: FlowEndpoint, callCount: number): number {
  const pSegs = page.name.split("/").filter(Boolean);
  const pNamed = pSegs.filter((s) => !s.startsWith(":")).map((s) => s.toLowerCase());
  const eNamed = meaningful(ep.path).map((s) => s.toLowerCase());
  let s = 0;
  for (const x of pNamed) if (eNamed.includes(x) || eNamed.includes(singular(x)) || eNamed.includes(plural(x))) s += 3;
  if (hasParam(page.name) && hasParam(ep.path)) s += 1;
  if (c.g.bindings.some((b) => b.pageKey === page.key && b.apiKey === ep.key)) s += 2;
  const fields = ((page.attrs?.fields as unknown[] | undefined) || []).length;
  const last = pNamed[pNamed.length - 1] || "";
  if (ep.method === "POST" && last === "new") s += 2;
  if ((ep.method === "PATCH" || ep.method === "PUT") && last === "edit") s += 2;
  if (ep.method === "DELETE" && hasParam(page.name) && last !== "edit") s += 1;
  if (ep.method !== "GET" && fields > 0) s += 0.5;
  s -= callCount * 0.15;
  return s;
}

function fieldsFor(c: Ctx, page: GNode, ep: FlowEndpoint | null, loose = false): Flow["fields"] {
  const all = c.g.bindings.filter((b) => b.pageKey === page.key && b.kind === "input");
  const writeTargets = new Set((c.out.get(page.key) || []).filter((e) => e.type === "calls" && e.to.startsWith("endpoint:")).map((e) => e.to).filter((k) => String(c.byKey.get(k)?.attrs?.method || "GET") !== "GET"));
  let mine: GBinding[];
  if (!ep) mine = all;
  else if (loose) mine = all;
  else {
    mine = all.filter((b) => b.apiKey === ep.key);
    // Unattributed bindings still describe this form when the page submits to one endpoint.
    if (!mine.length && ep.method !== "GET" && writeTargets.size === 1 && writeTargets.has(ep.key)) mine = all.filter((b) => !b.apiKey);
  }
  // Hub pages (settings-style, several forms) get every field attributed to one endpoint by the
  // resolver; keep only fields that demonstrably belong: column in a table this endpoint touches,
  // or key in its request body.
  if (ep && writeTargets.size > 2) {
    const touched = new Set([...ep.writes, ...ep.reads]);
    mine = mine.filter((b) => (b.tableName && touched.has(b.tableName)) || (b.keyName && ep.bodyKeys.includes(b.keyName)));
  }
  const seen = new Set<string>();
  return mine.filter((b) => !seen.has(b.fieldLabel) && seen.add(b.fieldLabel)).map((b) => ({ label: b.fieldLabel, keyName: b.keyName || undefined, column: b.tableName && b.columnName ? `${b.tableName}.${b.columnName}` : undefined }));
}

const effects = (ep: FlowEndpoint, plain: boolean) => {
  const parts: string[] = [];
  const verb = ep.method === "POST" ? "creates a row in" : ep.method === "DELETE" ? "removes rows from" : ep.method === "GET" ? "updates" : "updates";
  if (ep.writes.length) parts.push(plain ? `${verb} ${list(ep.writes.map(tableLabel))}` : `writes ${list(ep.writes, 4)}`);
  if (ep.reads.length) parts.push(plain ? `checks ${list(ep.reads.map(tableLabel))}` : `reads ${list(ep.reads, 4)}`);
  if (ep.externals.length) parts.push(plain ? `talks to ${list(ep.externals.map(cap))}` : `calls ${list(ep.externals, 4)}`);
  return parts;
};

function buildSteps(flow: Omit<Flow, "steps" | "summary" | "evidence">, who: string): FlowStep[] {
  const steps: FlowStep[] = [];
  const page = flow.page;
  const first = flow.endpoints[0];
  const fieldNames = flow.fields.map((f) => f.label).filter((l) => l.length <= 32);
  const pressed = first && first.method !== "GET" ? ` and presses ${first.title.split(" ")[0] === "Create" || first.title.split(" ")[0] === "Update" ? "Save" : first.title}` : "";
  if (flow.kind === "display") steps.push({ kind: "page", plain: `The ${who} opens the ${page.label.toLowerCase()}.`, technical: `${page.name}${page.file ? ` · ${page.file}` : ""}` });
  else if (fieldNames.length) steps.push({ kind: "page", plain: `On the ${page.label.toLowerCase()}, the ${who} fills in ${list(fieldNames, 4)}${pressed}.`, technical: `${page.name} · fields: ${fieldNames.join(", ")}${page.file ? ` · ${page.file}` : ""}` });
  else steps.push({ kind: "page", plain: `The ${who} ${first && first.method === "DELETE" ? "confirms the action" : "starts the action"} on the ${page.label.toLowerCase()}.`, technical: `${page.name}${page.file ? ` · ${page.file}` : ""}` });
  flow.endpoints.forEach((ep, i) => {
    const eff = effects(ep, true);
    const lead = flow.kind === "display" ? (i === 0 ? "The page asks the server for the data" : "It also loads more data") : (i === 0 ? "The app sends it to the server" : "The app then calls the server again");
    const plain = eff.length ? `${lead}, which ${list(eff, 3)}.` : `${lead}${flow.kind === "display" ? "" : " to " + ep.title.toLowerCase()}.`;
    const tech = [`${ep.method} ${ep.path}`, ep.bodyKeys.length ? `body: ${ep.bodyKeys.join(", ")}` : "", ...effects(ep, false), ep.auth === true ? "auth required" : ep.auth === false ? "public" : ""].filter(Boolean).join(" · ");
    steps.push({ kind: "api", plain, technical: tech });
  });
  if (first) {
    const m = first.method;
    steps.push({ kind: "result", plain: flow.kind === "display" ? `The page shows what came back.` : m === "DELETE" ? `The server confirms and the item disappears from the page.` : m === "POST" ? `The server confirms and the ${who} sees the result.` : `The server confirms and the page shows the updated details.`, technical: `Responds ${m === "POST" ? "201/200" : "200"} JSON · page re-renders` });
  }
  return steps;
}

function summaryFor(flow: Omit<Flow, "summary" | "evidence" | "steps">, who: string): string {
  const first = flow.endpoints[0];
  let s: string;
  if (flow.kind === "display") {
    const reads = [...new Set(flow.endpoints.flatMap((e) => [...e.reads, ...e.writes]))];
    s = reads.length ? `The ${who} opens ${flow.page.name} and the app loads ${list(reads.map(tableLabel))}.` : `The ${who} opens ${flow.page.name}; no database tables are linked yet.`;
  } else if (first) {
    const eff = effects(first, true);
    const fieldNames = flow.fields.map((f) => f.label).filter((l) => l.length <= 32);
    const start = fieldNames.length ? `The ${who} fills in ${list(fieldNames, 3)} on ${flow.page.name}` : `From ${flow.page.name}, the ${who} can ${first.title[0].toLowerCase() + first.title.slice(1)}`;
    s = eff.length ? `${start}; the server ${list(eff, 3)}.` : `${start}.`;
  } else s = `Starts on ${flow.page.name}.`;
  return s.length > 160 ? s.slice(0, 157).replace(/[,;\s]+\S*$/, "") + "..." : s;
}

function evidenceFor(c: Ctx, page: GNode, eps: FlowEndpoint[], apicalls: (GNode | undefined)[]): FlowEvidence[] {
  const ev: FlowEvidence[] = [];
  if (page.file) ev.push({ label: `Page ${page.name}`, file: page.file, line: page.lineStart, screen: "pages", sel: page.key });
  apicalls.forEach((ac, i) => { if (ac?.file && eps[i]) ev.push({ label: `Call to ${eps[i].method} ${eps[i].path}`, file: ac.file, line: ac.lineStart }); });
  for (const ep of eps) if (ep.file) ev.push({ label: `Handler ${ep.method} ${ep.path}`, file: ep.file, line: ep.line, screen: "apis", sel: ep.key });
  const seen = new Set<string>();
  return ev.filter((e) => { const k = `${e.label}|${e.file}|${e.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Pure: graph → flows. Works offline; titles/summaries are deterministic. */
export function deriveFlows(graph: LoadedGraph): Flow[] {
  const c = index(graph);
  const screens = graph.nodes.filter((n) => n.type === "screen");
  const endpoints = graph.nodes.filter((n) => n.type === "endpoint");
  const callCount = new Map<string, number>();
  for (const s of screens) callCount.set(s.key, (c.out.get(s.key) || []).filter((e) => e.type === "calls" && e.to.startsWith("endpoint:")).length);
  const flows: Flow[] = [];
  const claimed = new Map<string, string>(); // endpoint key → flow id (write endpoints become one action flow each)

  // Action flows: one per write endpoint reachable from a screen; home = page with best affinity.
  for (const ep of endpoints) {
    const method = String(ep.attrs?.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") continue;
    const callers = callersOf(c, ep.key);
    if (!callers.size) continue;
    const facts = endpointFacts(c, ep, null);
    const ranked = [...callers.entries()].map(([k, v]) => ({ page: c.byKey.get(k)!, ...v })).filter((x) => x.page).sort((a, b) => affinity(c, b.page, facts, callCount.get(b.page.key) || 0) - affinity(c, a.page, facts, callCount.get(a.page.key) || 0));
    const home = ranked[0];
    const epf = endpointFacts(c, ep, home.page, home.apicall);
    const kind: FlowKind = isAuthPath(epf.path) || isAuthPath(home.page.name) ? "auth" : isAdminPath(epf.path) ? "admin" : "action";
    const id = `${method.toLowerCase()}-${slug(epf.path)}`;
    const who = kind === "auth" ? "visitor" : "user";
    const tables = [...epf.writes.map((t) => ({ key: `table:${t}`, name: t, op: "writes" as const })), ...epf.reads.map((t) => ({ key: `table:${t}`, name: t, op: "reads" as const }))];
    const externals = epf.externals.map((x) => ({ key: `external:${x}`, name: c.byKey.get(`external:${x}`)?.name || x }));
    const base = { id, title: epf.title, kind, page: { key: home.page.key, name: home.page.name, label: pageLabel(home.page.name), file: home.page.file }, alsoFrom: ranked.slice(1).map((r) => ({ key: r.page.key, name: r.page.name })), endpoints: [epf], tables, externals, fields: fieldsFor(c, home.page, epf), confidence: Math.min(home.conf, ep.confidence ?? 1), source: "static" as const };
    flows.push({ ...base, summary: summaryFor(base, who), steps: buildSteps(base, who), evidence: evidenceFor(c, home.page, [epf], [home.apicall]) });
    claimed.set(ep.key, id);
  }

  // Fallback: write endpoints nobody provably calls, but a page's own path names them
  // (/register ↔ POST /api/auth/register). Dynamic URLs often hide these. Low confidence.
  for (const ep of endpoints) {
    if (claimed.has(ep.key)) continue;
    const method = String(ep.attrs?.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") continue;
    const facts = endpointFacts(c, ep, null);
    const segs = meaningful(facts.path).map((x) => x.toLowerCase());
    const last = segs[segs.length - 1];
    if (!last) continue;
    const candidates = screens.filter((s) => s.name.split("/").filter(Boolean).some((x) => !x.startsWith(":") && x.toLowerCase() === last));
    if (!candidates.length) continue;
    const home = candidates.sort((a, b) => affinity(c, b, facts, callCount.get(b.key) || 0) - affinity(c, a, facts, callCount.get(a.key) || 0))[0];
    const kind: FlowKind = isAuthPath(facts.path) || isAuthPath(home.name) ? "auth" : isAdminPath(facts.path) ? "admin" : "action";
    const who = kind === "auth" ? "visitor" : "user";
    const tables = [...facts.writes.map((t) => ({ key: `table:${t}`, name: t, op: "writes" as const })), ...facts.reads.map((t) => ({ key: `table:${t}`, name: t, op: "reads" as const }))];
    const externals = facts.externals.map((x) => ({ key: `external:${x}`, name: c.byKey.get(`external:${x}`)?.name || x }));
    const base = { id: `${method.toLowerCase()}-${slug(facts.path)}`, title: facts.title, kind, page: { key: home.key, name: home.name, label: pageLabel(home.name), file: home.file }, alsoFrom: [], endpoints: [facts], tables, externals, fields: fieldsFor(c, home, facts, true), confidence: 0.5, source: "static" as const };
    flows.push({ ...base, summary: summaryFor(base, who), steps: buildSteps(base, who), evidence: evidenceFor(c, home, [facts], [undefined]) });
    claimed.set(ep.key, base.id);
  }

  // Display flows: one per page that reads via GET endpoints (and pages that call nothing but exist with a file are skipped).
  for (const page of screens) {
    const edges = (c.out.get(page.key) || []).filter((e) => e.type === "calls" && e.to.startsWith("endpoint:"));
    const gets = [...new Set(edges.map((e) => e.to))].map((k) => c.byKey.get(k)).filter((n): n is GNode => !!n && String(n.attrs?.method || "GET").toUpperCase() === "GET");
    // Also reach GETs through apicall nodes the page contains.
    for (const e of c.out.get(page.key) || []) if (e.to.startsWith("apicall:") && (e.type === "contains" || e.type === "calls")) for (const d of c.out.get(e.to) || []) { const n = d.type === "calls" ? c.byKey.get(d.to) : undefined; if (n && n.type === "endpoint" && String(n.attrs?.method).toUpperCase() === "GET" && !gets.includes(n)) gets.push(n); }
    if (!gets.length) continue;
    const apicalls = gets.map((ep) => callersOf(c, ep.key).get(page.key)?.apicall);
    const epfs = gets.map((ep, i) => endpointFacts(c, ep, page, apicalls[i]));
    const conf = Math.min(1, ...gets.map((ep) => callersOf(c, ep.key).get(page.key)?.conf ?? 1), ...gets.map((ep) => ep.confidence ?? 1));
    const kind: FlowKind = isAuthPath(page.name) ? "auth" : "display";
    const who = kind === "auth" ? "visitor" : "user";
    const seenT = new Set<string>();
    const tables = epfs.flatMap((e) => [...e.writes.map((t) => ({ key: `table:${t}`, name: t, op: "writes" as const })), ...e.reads.map((t) => ({ key: `table:${t}`, name: t, op: "reads" as const }))]).filter((t) => !seenT.has(t.key) && seenT.add(t.key));
    const seenX = new Set<string>();
    const externals = epfs.flatMap((e) => e.externals).filter((x) => !seenX.has(x) && seenX.add(x)).map((x) => ({ key: `external:${x}`, name: c.byKey.get(`external:${x}`)?.name || x }));
    const base = { id: `view-${slug(page.name) || "home"}`, title: pageFlowTitle(page.name), kind, page: { key: page.key, name: page.name, label: pageLabel(page.name), file: page.file }, alsoFrom: [], endpoints: epfs, tables, externals, fields: [] as Flow["fields"], confidence: conf, source: "static" as const };
    flows.push({ ...base, summary: summaryFor(base, who), steps: buildSteps(base, who), evidence: evidenceFor(c, page, epfs, apicalls) });
  }

  const order: Record<FlowKind, number> = { auth: 0, action: 1, admin: 2, display: 3 };
  const writesOf = (f: Flow) => f.tables.filter((t) => t.op === "writes").length;
  return flows.sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === "display" ? a.title.localeCompare(b.title) : writesOf(b) - writesOf(a) || a.title.localeCompare(b.title)));
}

// ---------------------------------------------------------------- AI naming (cached)

const factsOf = (f: Flow) => ({ id: f.id, kind: f.kind, page: f.page.name, fields: f.fields.map((x) => x.label), endpoints: f.endpoints.map((e) => ({ method: e.method, path: e.path, body: e.bodyKeys, writes: e.writes, reads: e.reads, externals: e.externals })) });
const hashOf = (f: Flow) => crypto.createHash("sha1").update(JSON.stringify(factsOf(f))).digest("hex");
type Named = { id: string; title: string; summary: string };
const clean = (s: unknown, max: number) => typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
const okTitle = (t: string) => t.length >= 3 && t.length <= 40 && !/[{}<>]/.test(t);
const okSummary = (s: string) => s.length >= 10 && s.length <= 160 && !/[{}<>]/.test(s);

/**
 * Polish titles + summaries with one batched Groq call; results cached in Writeup (`flow:<id>`,
 * hash of the static facts). Any failure → static flows unchanged. Bounded by `timeoutMs`.
 */
export async function nameFlowsWithAI(projectId: string, flows: Flow[], timeoutMs = 6500): Promise<{ flows: Flow[]; ai: boolean }> {
  if (!(await aiReady()) || !flows.length) return { flows, ai: false };
  const hashes = new Map(flows.map((f) => [f.id, hashOf(f)]));
  const cached = await prisma.writeup.findMany({ where: { projectId, nodeKey: { in: flows.map((f) => `flow:${f.id}`) } } });
  const named = new Map<string, Named>();
  for (const w of cached) { const id = w.nodeKey.slice(5); if (w.hash !== hashes.get(id)) continue; const v = j<Named | null>(w.content, null); if (v && okTitle(clean(v.title, 40)) && okSummary(clean(v.summary, 160))) named.set(id, { id, title: clean(v.title, 40), summary: clean(v.summary, 160) }); }
  const todo = flows.filter((f) => !named.has(f.id));
  const apply = () => ({ flows: flows.map((f) => { const n = named.get(f.id); return n ? { ...f, title: n.title, summary: n.summary, source: "ai" as const } : f; }), ai: true });
  if (!todo.length) return apply();

  const call = (async () => {
    const facts = todo.map((f) => ({ ...factsOf(f), staticTitle: f.title }));
    const res = await chatJSON<{ flows: Partial<Named>[] }>(
      `You name user flows in a web app for a non-technical reader. For each flow you get static facts (page path, form fields, API method+path, tables written/read, external services). Return {"flows":[{"id": string (copy exactly), "title": string (2-5 words, imperative, what the user does: "Sign up", "Invite a teammate", "Browse saved links"; max 40 chars; never mention HTTP methods, URLs or table names), "summary": string (one calm plain-English sentence, max 160 chars, what happens end to end: who does what, what gets saved or sent; may name things like "your workspace", never code identifiers)}]}. Keep every id; one entry per id. Prefer the product's own vocabulary (e.g. "link", "workspace") over database names.`,
      untrusted("flow facts", JSON.stringify(facts)),
      { maxTokens: 3500, temperature: 0.2 },
    );
    const rows = Array.isArray(res?.flows) ? res!.flows : [];
    const ids = new Set(todo.map((f) => f.id));
    const upserts: Named[] = [];
    for (const r of rows) {
      const id = clean(r?.id, 120); const title = clean(r?.title, 40); const summary = clean(r?.summary, 160);
      if (!ids.has(id) || !okTitle(title) || !okSummary(summary)) continue;
      upserts.push({ id, title, summary });
    }
    for (const n of upserts) { named.set(n.id, n); await prisma.writeup.upsert({ where: { projectId_nodeKey: { projectId, nodeKey: `flow:${n.id}` } }, create: { projectId, nodeKey: `flow:${n.id}`, hash: hashes.get(n.id)!, content: JSON.stringify(n) }, update: { hash: hashes.get(n.id)!, content: JSON.stringify(n) } }); }
  })().catch((e) => console.error("nameFlowsWithAI failed", (e as Error).message));

  await Promise.race([call, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  return apply();
}
