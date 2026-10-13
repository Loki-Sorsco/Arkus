// Facts → Graph. Links frontend calls to endpoints, handlers to tables, and derives bindings
// (page field → request key → column). Everything inferred carries a confidence.
import { emptyFacts, nodeKey, normalizePath, type Facts, type GNode as GNodeT, type GBinding, type GEdge, type GNode, type Graph, type RouteFact, type TableFact, type Unresolved } from "./types";

const singular = (s: string) => s.endsWith("ies") ? s.slice(0, -3) + "y" : s.endsWith("ses") ? s.slice(0, -2) : s.endsWith("s") ? s.slice(0, -1) : s;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
export const humanize = (s: string) => s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, (c) => c.toUpperCase());

/** Map an ORM model / loose name to a known table name. */
export function tableLookup(tables: TableFact[]) {
  const byName = new Map<string, TableFact>();
  for (const t of tables) {
    byName.set(t.name.toLowerCase(), t);
    if (t.modelName) { byName.set(t.modelName.toLowerCase(), t); byName.set(snake(t.modelName), t); byName.set(snake(t.modelName) + "s", t); }
    byName.set(singular(t.name.toLowerCase()), t);
  }
  return (name: string): TableFact | undefined => {
    const n = name.toLowerCase().replace(/^public\./, "").replace(/"/g, "");
    return byName.get(n) || byName.get(snake(n)) || byName.get(singular(n)) || byName.get(snake(n) + "s") || byName.get(n + "s");
  };
}

/** Score how well a call path matches a route path (both normalized). 1 = exact, 0 = no match. */
export function matchPath(call: string, route: string): number {
  if (call === route) return 1;
  const a = call.split("/").filter(Boolean), b = route.split("/").filter(Boolean);
  if (a.length !== b.length) {
    // allow route catch-all
    if (b[b.length - 1]?.endsWith("*") && a.length >= b.length - 1) return 0.7;
    return 0;
  }
  let score = 1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ap = a[i].startsWith(":"), bp = b[i].startsWith(":");
    if (ap && bp) { score *= 0.95; continue; }
    if (bp) { score *= 0.9; continue; } // literal in call, param in route
    if (ap) { score *= 0.7; continue; } // dynamic in call, literal in route (weak)
    return 0;
  }
  return score;
}

export function resolveGraph(factsIn: Partial<Facts>, opts: { appName?: string } = {}): Graph {
  const f: Facts = { ...emptyFacts(), ...factsIn };
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const bindings: GBinding[] = [];
  const unresolved: Unresolved[] = [...f.unresolved];
  const addNode = (n: GNode) => { const ex = nodes.get(n.key); if (!ex) nodes.set(n.key, n); else { ex.confidence = Math.max(ex.confidence ?? 1, n.confidence ?? 1); if (!ex.file && n.file) { ex.file = n.file; ex.lineStart = n.lineStart; } ex.attrs = { ...(ex.attrs || {}), ...(n.attrs || {}) }; } return nodes.get(n.key)!; };
  const addEdge = (e: GEdge) => { if (!edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) edges.push(e); };
  const lookup = tableLookup(f.tables);

  const appKey = nodeKey.app(opts.appName || "app");
  addNode({ type: "app", key: appKey, name: opts.appName || "app" });

  // Tables + columns (merge duplicates from several sources: prefer introspection > prisma > sql)
  const prio: Record<string, number> = { introspection: 3, prisma: 2, drizzle: 2, typeorm: 2, sequelize: 2, mongoose: 2, sqlalchemy: 2, django: 2, designed: 2, sql: 1 };
  const tablesByName = new Map<string, TableFact>();
  const declared = new Map<string, TableFact>();   // what the code says (prisma / drizzle / sql ...), kept for drift
  for (const t of f.tables) {
    const k = t.name.toLowerCase();
    if (t.source !== "introspection") { const d = declared.get(k); if (!d || (prio[t.source] || 0) >= (prio[d.source] || 0)) declared.set(k, t); }
    const ex = tablesByName.get(k);
    if (!ex || (prio[t.source] || 0) >= (prio[ex.source] || 0)) tablesByName.set(k, ex ? { ...t, rowEstimate: t.rowEstimate ?? ex.rowEstimate, modelName: t.modelName ?? ex.modelName, file: t.file ?? ex.file, line: t.line ?? ex.line } : t);
  }
  for (const t of tablesByName.values()) {
    const tk = nodeKey.table(t.name);
    const decl = declared.get(t.name.toLowerCase());
    const code = decl && decl !== t ? { codeSource: decl.source, codeColumns: decl.columns, codeFile: decl.file } : {};
    addNode({ type: "table", key: tk, name: t.name, file: t.file, lineStart: t.line, attrs: { modelName: t.modelName, source: t.source, rowEstimate: t.rowEstimate, columns: t.columns, indexes: t.indexes, ...code }, evidence: [{ kind: t.source === "introspection" ? "runtime" : "static", file: t.file, line: t.line }] });
    addEdge({ from: appKey, to: tk, type: "contains" });
    for (const c of t.columns) {
      const ck = nodeKey.column(t.name, c.name);
      addNode({ type: "column", key: ck, name: c.name, attrs: { ...c, table: t.name } });
      addEdge({ from: tk, to: ck, type: "contains" });
      if (c.references) {
        const target = lookup(c.references.table);
        if (target) { addEdge({ from: ck, to: nodeKey.column(target.name, c.references.column), type: "references" }); addEdge({ from: tk, to: nodeKey.table(target.name), type: "references" }); }
      }
    }
  }

  // Endpoints
  const routes: (RouteFact & { key: string })[] = [];
  for (const r of f.routes) {
    const path = normalizePath(r.path);
    const key = nodeKey.endpoint(r.method, path);
    routes.push({ ...r, path, key });
    addNode({ type: "endpoint", key, name: `${r.method} ${path}`, file: r.file, lineStart: r.line, lineEnd: r.lineEnd, confidence: r.confidence ?? 1, attrs: { method: r.method, path, framework: r.framework, handlerName: r.handlerName, auth: r.auth ?? "unknown", bodyKeys: r.bodyKeys || [], responseKeys: r.responseKeys || [], description: r.description }, evidence: [{ kind: r.framework === "openapi" ? "openapi" : "static", file: r.file, line: r.line }, ...(r.evidence || [])] });
    addEdge({ from: appKey, to: key, type: "contains" });
    for (const t of r.tablesRead || []) { const tt = lookup(t); if (tt) addEdge({ from: key, to: nodeKey.table(tt.name), type: "reads", confidence: 0.9 }); }
    for (const t of r.tablesWritten || []) { const tt = lookup(t); if (tt) addEdge({ from: key, to: nodeKey.table(tt.name), type: "writes", confidence: 0.9 }); }
  }

  // ORM usage inside handler files → endpoint reads/writes
  const routesByFile = new Map<string, (RouteFact & { key: string })[]>();
  for (const r of routes) { const arr = routesByFile.get(r.file) || []; arr.push(r); routesByFile.set(r.file, arr); }
  const fileTables = new Map<string, { table: string; op: "read" | "write"; line?: number }[]>();
  const seenUnknown = new Set<string>();
  for (const u of f.ormUsage) {
    const t = lookup(u.table);
    if (!t) {
      // Raw-SQL regexes over prose produce false positives ("the", "this"); only model-based ORMs are worth flagging.
      if (u.via !== "sql" && u.via !== "knex" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(u.table) && !seenUnknown.has(u.table.toLowerCase())) { seenUnknown.add(u.table.toLowerCase()); unresolved.push({ kind: "table_no_model", key: u.table, file: u.file, line: u.line, message: `Code touches "${u.table}" but no such table/model was found` }); }
      continue;
    }
    const arr = fileTables.get(u.file) || []; arr.push({ table: t.name, op: u.op, line: u.line }); fileTables.set(u.file, arr);
  }
  // Attribute usage to the endpoint whose line range contains it, else to every endpoint in the file.
  for (const [file, uses] of fileTables) {
    const rs = routesByFile.get(file) || [];
    for (const u of uses) {
      let targets = rs.filter((r) => r.line != null && r.lineEnd != null && u.line != null && u.line >= r.line && u.line <= r.lineEnd);
      if (!targets.length) targets = rs;
      for (const r of targets) addEdge({ from: r.key, to: nodeKey.table(u.table), type: u.op === "read" ? "reads" : "writes", confidence: targets.length === rs.length && rs.length > 1 ? 0.6 : 0.9, evidence: [{ kind: "static", file, line: u.line }] });
    }
  }
  // Indirect: handler imports a service file that uses the ORM. One hop: files that use tables but have no routes → link to routes whose file name shares the resource name.
  for (const [file, uses] of fileTables) {
    if (routesByFile.has(file)) continue;
    const base = file.split("/").pop()!.replace(/\.(ts|js|tsx|jsx|py)$/, "").toLowerCase().replace(/[-_.](service|repo|repository|model|controller|dao|queries)$/, "");
    for (const r of routes) {
      const seg = r.path.split("/").filter((s) => s && !s.startsWith(":"));
      if (seg.some((s) => singular(s.toLowerCase()) === singular(base))) for (const u of uses) addEdge({ from: r.key, to: nodeKey.table(u.table), type: u.op === "read" ? "reads" : "writes", confidence: 0.5, evidence: [{ kind: "inferred", file, line: u.line, note: "via service file name" }] });
    }
  }
  for (const r of routes) if (!edges.some((e) => e.from === r.key && (e.type === "reads" || e.type === "writes")) && r.method !== "GET" && f.tables.length) unresolved.push({ kind: "endpoint_no_tables", key: r.key, file: r.file, line: r.line, message: `${r.method} ${r.path} — couldn't tell which tables it touches` });

  // Screens + components
  const screenByFile = new Map<string, string>();
  for (const s of f.screens) {
    const key = s.kind === "page" ? nodeKey.screen(normalizePath(s.path)) : nodeKey.component(s.file);
    addNode({ type: s.kind === "page" ? "screen" : "component", key, name: s.kind === "page" ? normalizePath(s.path) : s.name, file: s.file, attrs: { fields: s.fields || [], componentsUsed: s.componentsUsed || [], kind: (s.fields?.length ? "form" : "display") } });
    if (s.kind === "page") addEdge({ from: appKey, to: key, type: "contains" });
    screenByFile.set(s.file, key);
  }
  // component → page attribution: page renders component (by file match on componentsUsed)
  const pages = f.screens.filter((s) => s.kind === "page");
  const comps = f.screens.filter((s) => s.kind === "component");
  for (const p of pages) for (const cu of p.componentsUsed || []) {
    const c = comps.find((x) => x.file === cu || x.file.replace(/\.(tsx|jsx|ts|js)$/, "") === cu.replace(/\.(tsx|jsx|ts|js)$/, "") || x.name === cu);
    if (c) addEdge({ from: screenByFile.get(p.file)!, to: screenByFile.get(c.file)!, type: "renders" });
  }
  const stripExt = (f: string) => f.replace(/\.(tsx|jsx|ts|js|vue|svelte)$/, "").replace(/\/index$/, "");
  const pagesUsing = (file: string): string[] => pages.filter((p) => (p.componentsUsed || []).some((cu) => cu === file || stripExt(cu) === stripExt(file))).map((p) => screenByFile.get(p.file)!).filter(Boolean);
  const ownersOf = (file: string): string[] => {
    const k = screenByFile.get(file);
    if (k?.startsWith("screen:")) return [k];
    const viaRenders = k ? edges.filter((e) => e.type === "renders" && e.to === k).map((e) => e.from) : [];
    const viaImports = pagesUsing(file);
    const owners = [...new Set([...viaRenders, ...viaImports])];
    return owners.length ? owners : k ? [k] : [];
  };

  // API calls → endpoints
  const isFrontendFile = (file: string) => /\.(tsx|jsx|vue|svelte)$/.test(file) || /(^|\/)(app|pages|components|src\/app|src\/pages|src\/components|client|web|frontend)\//.test(file);
  for (const c of f.apicalls) {
    // Calls to other hosts are external services, not endpoints of this app.
    const ext = /^https?:\/\/([^/]+)/i.exec(c.path.trim());
    if (ext) {
      const host = ext[1].replace(/^(api|www)\./, "");
      const name = host.split(".").slice(0, -1).join(".") || host;
      const k = nodeKey.external(name);
      addNode({ type: "external", key: k, name, file: c.fromFile, attrs: { evidence: `calls ${ext[0]}`, host } });
      addEdge({ from: appKey, to: k, type: "contains" });
      for (const r of routesByFile.get(c.fromFile) || []) addEdge({ from: r.key, to: k, type: "calls", confidence: 0.9, evidence: [{ kind: "static", file: c.fromFile, line: c.line }] });
      continue;
    }
    // Dynamic URLs from backend code / scripts are noise, not missing endpoints.
    if (c.dynamic && c.path.replace(/^\//, "") === ":dynamic" && !isFrontendFile(c.fromFile)) continue;
    const path = normalizePath(c.path);
    const owners = ownersOf(c.fromFile);
    const fromKeys = owners.length ? owners : [nodeKey.component(c.fromFile)];
    if (!owners.length) addNode({ type: "component", key: nodeKey.component(c.fromFile), name: c.fromFile.split("/").pop()!, file: c.fromFile, attrs: { fields: [], kind: "module" } });
    let best: { r: RouteFact & { key: string }; s: number } | null = null;
    for (const r of routes) {
      if (r.method !== "ANY" && c.method !== "ANY" && r.method !== c.method) continue;
      const s = matchPath(path, r.path) * (r.method === "ANY" || c.method === "ANY" ? 0.9 : 1);
      if (s > 0 && (!best || s > best.s)) best = { r, s };
    }
    const callKey = nodeKey.apicall(c.fromFile, c.method, path);
    addNode({ type: "apicall", key: callKey, name: `${c.method} ${path}`, file: c.fromFile, lineStart: c.line, confidence: best ? best.s : 0.3, attrs: { method: c.method, path, lib: c.lib, dynamic: !!c.dynamic, bodyKeys: c.bodyKeys || [], resolved: !!best } });
    for (const fk of fromKeys) addEdge({ from: fk, to: callKey, type: "contains" });
    if (best && best.s >= 0.5) {
      addEdge({ from: callKey, to: best.r.key, type: "calls", confidence: Math.min(best.s, c.dynamic ? 0.7 : 1), evidence: [{ kind: c.dynamic ? "inferred" : "static", file: c.fromFile, line: c.line }] });
      for (const fk of fromKeys) addEdge({ from: fk, to: best.r.key, type: "calls", confidence: best.s });
    } else {
      if (isFrontendFile(c.fromFile) || !c.dynamic) unresolved.push({ kind: c.dynamic ? "dynamic_url" : "apicall_no_endpoint", key: callKey, file: c.fromFile, line: c.line, message: `${c.method} ${path} is called from ${c.fromFile.split("/").pop()} but no matching endpoint was found${routes.length ? "" : " (no backend routes detected — maybe an external API or separate repo)"}` });
    }
  }

  // Externals
  for (const e of f.externals) { const k = nodeKey.external(e.name); addNode({ type: "external", key: k, name: e.name, file: e.file, attrs: { evidence: e.evidence } }); addEdge({ from: appKey, to: k, type: "contains" });
    const rs = routesByFile.get(e.file) || []; for (const r of rs) addEdge({ from: r.key, to: k, type: "calls", confidence: 0.8 }); }

  // Bindings: for each page with fields → the endpoint(s) it POSTs to → body keys → columns of tables that endpoint writes
  for (const p of pages) {
    const pk = screenByFile.get(p.file)!;
    const calls = edges.filter((e) => e.from === pk && e.type === "calls").map((e) => nodes.get(e.to)!).filter(Boolean);
    const writeCalls = calls.filter((n) => n.attrs?.method !== "GET");
    const pageCalls = f.apicalls.filter((c) => c.fromFile === p.file || (p.componentsUsed || []).some((cu) => cu === c.fromFile || stripExt(cu) === stripExt(c.fromFile)));
    const fieldKeys = new Set((p.fields || []).map((fl) => (fl.name || snake(fl.label)).toLowerCase()));
    // Pick the submit target: the write call whose body keys overlap the form most, then the one that writes tables.
    const score = (n: GNodeT) => {
      const sent = pageCalls.filter((c) => c.method === n.attrs?.method && normalizePath(c.path) === n.attrs?.path).flatMap((c) => c.bodyKeys || []);
      const overlap = [...new Set([...sent, ...(((n.attrs?.bodyKeys as { name: string }[]) || []).map((b) => b.name))])].filter((k) => fieldKeys.has(k.toLowerCase())).length;
      const writes = edges.filter((e) => e.from === n.key && e.type === "writes").length;
      return overlap * 3 + writes * 2 + (n.attrs?.method === "POST" ? 1 : 0);
    };
    const target = [...writeCalls].sort((a, b) => score(b) - score(a))[0] || calls[0];
    const writtenTables = target ? [...edges.filter((e) => e.from === target.key && e.type === "writes"), ...edges.filter((e) => e.from === target.key && e.type === "reads")].map((e) => nodes.get(e.to)!).filter(Boolean) : [];
    const sentKeys = new Set<string>([...(target ? pageCalls.filter((c) => c.method === target.attrs?.method && normalizePath(c.path) === target.attrs?.path) : pageCalls).flatMap((c) => c.bodyKeys || []), ...((target?.attrs?.bodyKeys as { name: string }[] | undefined)?.map((b) => b.name) || [])]);
    const sentList = [...sentKeys];
    const looksLikePlaceholder = (l: string) => /@|\.\.\.|…|e\.g\.|^\d+$|at least|enter |your |https?:|\/|,|^[A-Z]{2,}-\d+$/i.test(l) || l.split(" ").length > 4;
    const inferKey = (field: { label: string; name?: string; uiType: string }): string => {
      if (field.name) return field.name;
      const lab = field.label.toLowerCase();
      const byType: Record<string, string[]> = { email: ["email", "email_address", "user_email"], password: ["password", "pass"], tel: ["phone", "phone_number", "mobile"], phone: ["phone", "phone_number", "mobile"] };
      for (const k of byType[field.uiType] || []) if (sentList.includes(k)) return k;
      const hit = sentList.find((k) => lab.includes(k.replace(/_/g, " ")) || lab.includes(k) || snake(lab).includes(k));
      if (hit) return hit;
      if (looksLikePlaceholder(field.label)) return field.uiType === "email" ? "email" : field.uiType === "password" ? "password" : snake(field.label.split(/[,.…]/)[0]).slice(0, 40);
      return snake(field.label);
    };
    for (const field of p.fields || []) {
      const keyName = inferKey(field);
      const bodyKey = (target?.attrs?.bodyKeys as { name: string; type?: string; required?: boolean; validation?: string }[] | undefined)?.find((b) => b.name === keyName || snake(b.name) === snake(keyName));
      const isSent = sentKeys.size === 0 ? true : sentKeys.has(keyName) || !!bodyKey;
      const confirmKind = /confirm|repeat|again/i.test(field.label) || /confirm/i.test(keyName);
      let col: { table: string; column: string; type: string } | undefined;
      for (const t of writtenTables) {
        const cols = (t.attrs?.columns as { name: string; type: string }[] | undefined) || [];
        const c = cols.find((c) => c.name === keyName || snake(c.name) === snake(keyName) || c.name === snake(field.label));
        if (c) { col = { table: t.name, column: c.name, type: c.type }; break; }
      }
      const label = looksLikePlaceholder(field.label) ? humanize(field.name || keyName) : field.label;
      // Not matched to any request key: still an input (the key is unknown), unless it's clearly local (confirm password etc.).
      const matched = isSent || !!bodyKey;
      bindings.push({ pageKey: pk, fieldLabel: label, uiType: field.uiType, apiKey: !confirmKind && target ? target.key : undefined, keyName: matched && !confirmKind ? (bodyKey?.name || keyName) : undefined, keyType: bodyKey?.type, tableName: col?.table, columnName: col?.column, colType: col?.type, kind: confirmKind || !target ? "frontend_only" : "input", source: "static", confidence: col && matched ? 0.9 : col ? 0.7 : matched && target ? 0.6 : 0.4 });
    }
    // server-filled rows: columns of the written table not covered by a field
    if (target && target.attrs?.method !== "GET" && writtenTables[0] && (p.fields || []).length) {
      const cols = (writtenTables[0].attrs?.columns as { name: string; type: string; default?: string; pk?: boolean }[] | undefined) || [];
      for (const c of cols) {
        if (bindings.some((b) => b.pageKey === pk && b.columnName === c.name && b.tableName === writtenTables[0].name)) continue;
        if (c.pk || c.default || /^(created|updated)_?at$/i.test(c.name)) bindings.push({ pageKey: pk, fieldLabel: humanize(c.name), uiType: "server", apiKey: target.key, tableName: writtenTables[0].name, columnName: c.name, colType: c.type, kind: "server", source: "static", confidence: 0.8 });
      }
    }
  }

  return { nodes: [...nodes.values()], edges, bindings, unresolved };
}
