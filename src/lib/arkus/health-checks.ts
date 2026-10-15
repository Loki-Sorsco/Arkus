// Health: the individual checks. Each returns plain-English issues; health.ts scores them.
// Every `why` is one sentence a beginner can follow; every `fix` says what to actually do.
import type { GNode, Unresolved } from "./types";
import type { LoadedGraph } from "./graph";
import type { Issue, Severity, Area } from "./health";
import { anyTypes, consoleLogs, handlerSlice, hasErrorHandling, hasTryCatch, hasValidation, isClientComponent, readsBody, resolveImport, scanSecurity, segmentHandled, wrapperOf, type AuditSummary, type Finding, type ScannedFile } from "./health-scan";

type Files = Map<string, ScannedFile>;
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const META_TABLE = /^(_prisma_migrations|drizzle_migrations|__drizzle_migrations|knex_migrations.*|schema_migrations|sqlite_sequence|ar_internal_metadata|django_migrations|alembic_version|flyway_schema_history)$/i;
const SECRET_COL = /password|passwd|secret|token|api_?key|private_?key|credential/i;

const list = (names: string[], max = 6) => names.slice(0, max).join(", ") + (names.length > max ? ` and ${names.length - max} more` : "");
const mk = (area: Area, severity: Severity, id: string, title: string, why: string, fix: string, extra: Partial<Issue> = {}): Issue => ({ id: `${area}:${id}`.replace(/[^A-Za-z0-9:_./-]+/g, "_").slice(0, 160), area, severity, title, why, fix, ...extra });
const method = (n: GNode) => String(n.attrs?.method || "ANY").toUpperCase();
const epName = (n: GNode) => n.name;

// ---------------------------------------------------------------- security
export function securityChecks(graph: LoadedGraph, files: Files, audit: AuditSummary): Issue[] {
  const out: Issue[] = [];
  // 1. Secrets the indexer already spotted + our own regex pass (grouped per file; never the value).
  const perFile = new Map<string, Finding[]>();
  for (const f of files.values()) for (const x of scanSecurity(f)) { const a = perFile.get(x.file) || []; a.push(x); perFile.set(x.file, a); }
  for (const u of graph.unresolved.filter((x: Unresolved) => x.kind === "secret_in_repo")) out.push(mk("security", "high", `secret:${u.file || u.key || u.message}`, "A secret is committed in the code", "Anyone who can read the repository can copy this key and use your account.", "Move the value into an environment variable (.env, which git ignores), load it with process.env, then revoke the old key and issue a new one.", { file: u.file, line: u.line }));
  for (const [file, fs] of perFile) {
    const secrets = fs.filter((x) => x.kind === "secret");
    if (secrets.length) out.push(mk("security", "high", `secret:${file}`, `Secret-looking value in ${file.split("/").pop()}`, `This file contains ${secrets[0].detail}; anyone with the code can use it.`, `Open ${file}:${secrets[0].line}, move the value to .env, read it with process.env, and rotate the key because it is already exposed.`, { file, line: secrets[0].line, count: secrets.length }));
    for (const x of fs.filter((y) => y.kind === "sql_concat")) out.push(mk("security", "high", `sql:${file}:${x.line}`, "SQL query built from variables", "Pasting user input straight into SQL lets an attacker change the query (SQL injection) and read or delete data.", "Use parameters instead of string building: Prisma's $queryRaw tagged template, `?` placeholders, or the ORM's query methods.", { file, line: x.line }));
    for (const x of fs.filter((y) => y.kind === "eval")) out.push(mk("security", "high", `eval:${file}:${x.line}`, "Code runs eval or new Function", "Running text as code lets any string that reaches it execute on your server or in the browser.", "Replace eval with a direct function call, JSON.parse for data, or a small lookup table of allowed actions.", { file, line: x.line }));
    for (const x of fs.filter((y) => y.kind === "env_fallback")) out.push(mk("security", "high", `envfb:${file}:${x.line}`, "Secret has a hard-coded fallback", "If the environment variable is missing, the app silently uses a value written in the code, which attackers can read.", "Remove the fallback and throw an error at startup when the variable is not set; keep the real value only in .env.", { file, line: x.line }));
    for (const x of fs.filter((y) => y.kind === "cors_any")) out.push(mk("security", "medium", `cors:${file}:${x.line}`, "CORS allows every website", "With Access-Control-Allow-Origin set to *, any site a user visits can call your API from their browser.", "List the exact origins you trust (for example your own domain) instead of *.", { file, line: x.line }));
    for (const x of fs.filter((y) => y.kind === "dangerous_html")) out.push(mk("security", "medium", `html:${file}:${x.line}`, "Raw HTML injected into a page", "dangerouslySetInnerHTML renders text as HTML, so user-supplied text can run scripts in other users' browsers (XSS).", "Render the text as normal React content, or sanitise it first with a library such as DOMPurify.", { file, line: x.line }));
  }
  // 2. Public write endpoints.
  for (const n of graph.nodes) if (n.type === "endpoint" && n.attrs?.auth === false && WRITE.has(method(n))) out.push(mk("security", "high", `public:${n.key}`, `${epName(n)} can be called by anyone`, "This endpoint changes data but does not check who is calling, so anyone on the internet can trigger it.", "Check the session or API key at the top of the handler and return 401 when it is missing.", { nodeKey: n.key, file: n.file, line: n.lineStart }));
  // 3. npm audit.
  if (audit && audit.total > 0) {
    const sev: Severity = audit.critical + audit.high > 0 ? "high" : audit.moderate > 0 ? "medium" : "low";
    out.push(mk("security", sev, "npm-audit", `${audit.total} vulnerable package${audit.total === 1 ? "" : "s"} in dependencies`, `npm audit found ${audit.critical} critical, ${audit.high} high, ${audit.moderate} moderate and ${audit.low} low known problems in packages your app depends on.`, "Run `npm audit fix` (or `npm audit` to read the details) and update the packages it lists; re-run the check afterwards."));
  }
  return out;
}

// ---------------------------------------------------------------- api
export function apiChecks(graph: LoadedGraph, files: Files): Issue[] {
  const out: Issue[] = [];
  const eps = graph.nodes.filter((n) => n.type === "endpoint");
  const writes = new Map<string, number>(); const reads = new Set<string>(); const calledBy = new Set<string>(); const callsExt = new Set<string>();
  for (const e of graph.edges) {
    if (e.type === "writes") writes.set(e.from, Math.max(writes.get(e.from) || 0, e.confidence ?? 1));
    else if (e.type === "reads") reads.add(e.from);
    else if (e.type === "calls") { if (e.to.startsWith("endpoint:") && (e.from.startsWith("screen:") || e.from.startsWith("component:") || e.from.startsWith("apicall:"))) calledBy.add(e.to); if (e.to.startsWith("external:")) callsExt.add(e.from); }
  }
  const idle = eps.filter((n) => !writes.has(n.key) && !reads.has(n.key) && !callsExt.has(n.key));
  if (idle.length) out.push(mk("api", "info", "idle", `${idle.length} endpoint${idle.length === 1 ? "" : "s"} touch no table or service`, "Arkus could not see these endpoints reading or writing anything, which usually means they are helpers, proxies, or code the indexer could not follow.", `Check they are still needed: ${list(idle.map(epName))}. Delete dead ones; nothing to do if they are intentional.`, { count: idle.length, nodeKey: idle[0].key }));
  const unused = eps.filter((n) => !calledBy.has(n.key));
  if (unused.length && unused.length < eps.length) out.push(mk("api", "low", "unused", `${unused.length} endpoint${unused.length === 1 ? " is" : "s are"} never called from a page`, "No page or component in this codebase calls these, so they are either for external clients or no longer used.", `If they are for outside callers (mobile app, webhooks, API keys) ignore this; otherwise remove them: ${list(unused.map(epName))}.`, { count: unused.length, nodeKey: unused[0].key }));
  for (const u of graph.unresolved) {
    if (u.kind === "apicall_no_endpoint") out.push(mk("api", "medium", `nocall:${u.key || u.file}:${u.line}`, "A page calls an API that does not exist", `${u.message}; the request will fail with a 404 at runtime.`, "Fix the URL or method in the page, or add the missing route on the server.", { file: u.file, line: u.line, nodeKey: u.key }));
    else if (u.kind === "dynamic_url") out.push(mk("api", "info", `dyn:${u.key || u.file}:${u.line}`, "API URL is built at runtime", `${u.message}; Arkus cannot check it before the app runs.`, "Nothing to fix unless the call fails; a constant path (or a shared helper) makes it checkable.", { file: u.file, line: u.line }));
  }
  // Handler-level checks: group endpoints by file so slices stop at the next route.
  const byFile = new Map<string, GNode[]>();
  for (const n of eps) if (n.file) { const a = byFile.get(n.file) || []; a.push(n); byFile.set(n.file, a); }
  for (const [file, group] of byFile) {
    const f = files.get(file); if (!f) continue;
    const starts = group.map((n) => n.lineStart || 0).filter(Boolean);
    const fileHasTry = hasTryCatch(f.text), fileHasValidation = hasValidation(f.text);
    for (const n of group) {
      const m = method(n); const slice = handlerSlice(f, n.lineStart, n.lineEnd, starts);
      const isWrite = WRITE.has(m); const conf = writes.get(n.key) || 0;
      // A write edge attributed to the whole file (0.6) only counts for methods that are meant to write.
      const writesTable = conf >= 0.8 || (isWrite && conf > 0);
      // `export const POST = withAuth(async ...)`: the wrapper usually owns the try/catch; follow the import to check.
      const wrapper = wrapperOf(slice.text);
      const wrapperFile = wrapper ? resolveImport(files, file, wrapper) : undefined;
      const wrapped = !!wrapper && (!wrapperFile || hasTryCatch(wrapperFile.text));
      if (!hasTryCatch(slice.text) && !fileHasTry && !wrapped) out.push(mk("api", writesTable ? "medium" : "low", `trycatch:${n.key}`, `${epName(n)} has no error handling`, writesTable ? "If the database write fails, the user gets a generic 500 and a half-finished change may be left behind." : "If anything inside throws, the caller gets an unhelpful 500 instead of a clear message.", "Wrap the body in try/catch, return a JSON error with a proper status code, and log the real error on the server.", { nodeKey: n.key, file, line: n.lineStart }));
      if (slice.lines > 150) out.push(mk("api", "low", `long:${n.key}`, `${epName(n)} is ${slice.lines} lines long`, "Long handlers are hard to read and test, so bugs hide in them.", "Move validation, database work and response shaping into small named functions in a lib/ or services/ file.", { nodeKey: n.key, file, line: n.lineStart }));
      const bodyKeys = (n.attrs?.bodyKeys as unknown[] | undefined) || [];
      if (isWrite && (bodyKeys.length || readsBody(slice.text)) && !hasValidation(slice.text) && !fileHasValidation) out.push(mk("api", "medium", `noval:${n.key}`, `${epName(n)} does not validate its input`, "The handler trusts whatever the request sends, so missing or wrong fields reach your database and cause odd errors.", "Describe the expected body with zod (or similar), call schema.safeParse(body) first, and return 400 with the problems when it fails.", { nodeKey: n.key, file, line: n.lineStart }));
      if (m === "GET" && (writes.get(n.key) || 0) >= 0.8) out.push(mk("api", "medium", `getwrite:${n.key}`, `${epName(n)} is a GET that changes data`, "Browsers, crawlers and prefetching may call GET URLs on their own, so data can change without anyone meaning to.", "Move the write into a POST (or PUT/PATCH/DELETE) handler and keep GET read-only.", { nodeKey: n.key, file, line: n.lineStart }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- frontend
export function frontendChecks(graph: LoadedGraph, files: Files): Issue[] {
  const out: Issue[] = [];
  const pages = graph.nodes.filter((n) => n.type === "screen");
  const comps = graph.nodes.filter((n) => n.type === "component");
  const names = new Map(graph.nodes.map((n) => [n.key, n.name]));
  // Form fields that go nowhere.
  const loose = new Map<string, string[]>();
  for (const b of graph.bindings) if (b.kind === "input" && !b.keyName && !b.columnName) { const a = loose.get(b.pageKey) || []; a.push(b.fieldLabel); loose.set(b.pageKey, a); }
  for (const [pk, fields] of loose) out.push(mk("frontend", "medium", `loose:${pk}`, `${names.get(pk) || pk} has ${fields.length} field${fields.length === 1 ? " that goes" : "s that go"} nowhere`, `Arkus could not match ${list(fields, 4)} to a request key or a database column, so what the user types may be silently dropped.`, "Give each input a name that matches the body key the API expects, or remove the field if it is no longer used.", { nodeKey: pk, count: fields.length, file: graph.nodes.find((n) => n.key === pk)?.file }));
  // Pages that call APIs but show no error/loading state. Server components (no "use client") hand errors to
  // the nearest error.tsx / loading.tsx, so only flag them when no such file exists above the page.
  const callers = new Set(graph.edges.filter((e) => e.type === "calls" && e.from.startsWith("screen:")).map((e) => e.from));
  for (const p of pages) {
    const f = p.file ? files.get(p.file) : undefined; if (!f || !callers.has(p.key)) continue;
    const client = isClientComponent(f.text);
    const handled = hasErrorHandling(f.text) || (!client && segmentHandled(files, p.file!));
    if (!handled) out.push(mk("frontend", "low", `noerr:${p.key}`, `${p.name} shows nothing while loading or when a request fails`, client ? "The page calls an API but has no loading or error state, so users see a blank or frozen screen when the network is slow or the call fails." : "This server page fetches data with no error.tsx or loading.tsx above it, so a failure shows a bare error screen and a slow fetch shows nothing.", client ? "Keep loading and error state in the component and show a short message with a retry." : "Add an error.tsx (and optionally loading.tsx) next to the page or in the app/ folder so users see a friendly message.", { nodeKey: p.key, file: p.file }));
  }
  for (const n of [...pages, ...comps]) {
    if (n.attrs?.kind === "module") continue; // plain modules (scripts, libs) that happen to call an API are not UI
    const f = n.file ? files.get(n.file) : undefined; if (!f) continue;
    if (f.lines.length > 400) out.push(mk("frontend", "low", `big:${n.file}`, `${n.file!.split("/").pop()} is ${f.lines.length} lines long`, "Very large components are slow to understand and easy to break when edited.", "Split it into smaller components (one per visual block) and move data fetching into a hook.", { nodeKey: n.key, file: n.file }));
    const logs = consoleLogs(f.text);
    if (logs) out.push(mk("frontend", "info", `log:${n.file}`, `console.log left in ${n.file!.split("/").pop()}`, `${logs} console.log call${logs === 1 ? "" : "s"} will print in every visitor's browser console, sometimes including private data.`, "Delete the console.log lines or route them through a logger that is off in production.", { nodeKey: n.key, file: n.file, count: logs }));
  }
  let anyCount = 0, anyFiles = 0;
  for (const f of files.values()) if (/\.(ts|tsx|mts|cts)$/.test(f.rel)) { const c = anyTypes(f.text); if (c) { anyCount += c; anyFiles++; } }
  if (anyCount) out.push(mk("frontend", "info", "any", `${anyCount} use${anyCount === 1 ? "" : "s"} of the any type across ${anyFiles} file${anyFiles === 1 ? "" : "s"}`, "any switches TypeScript off for that value, so typos and wrong shapes are only found at runtime.", "Replace any with the real type (or unknown plus a check) starting with the files you edit most.", { count: anyCount }));
  return out;
}

// ---------------------------------------------------------------- database
type Col = { name: string; type?: string; pk?: boolean; unique?: boolean; nullable?: boolean; references?: { table: string; column: string }; index?: boolean };
export function databaseChecks(graph: LoadedGraph): Issue[] {
  const out: Issue[] = [];
  const tables = graph.nodes.filter((n) => n.type === "table" && !META_TABLE.test(n.name));
  const touched = new Map<string, { read: boolean; write: boolean }>();
  for (const e of graph.edges) if (e.type === "reads" || e.type === "writes") { const t = touched.get(e.to) || { read: false, write: false }; if (e.type === "reads") t.read = true; else t.write = true; touched.set(e.to, t); }
  for (const t of tables) {
    const cols = (t.attrs?.columns as Col[] | undefined) || [];
    const indexes = (t.attrs?.indexes as { columns: string[] }[] | undefined) || [];
    const prisma = t.attrs?.source === "prisma" || t.attrs?.codeSource === "prisma";
    if (cols.length && !cols.some((c) => c.pk)) out.push(mk("database", "high", `nopk:${t.key}`, `Table ${t.name} has no primary key`, "Without a primary key, rows cannot be told apart reliably, so updates and deletes can hit the wrong row and ORMs refuse to work with the table.", prisma ? `Add an id column with @id (for example \`id String @id @default(cuid())\`) to the ${t.name} model and run a migration.` : `Add an id column and declare it PRIMARY KEY on ${t.name}.`, { nodeKey: t.key, file: t.file, line: t.lineStart }));
    const indexed = new Set(indexes.map((i) => i.columns[0]?.toLowerCase()).filter(Boolean));
    const fks = cols.filter((c) => c.references && !c.pk && !c.index && !c.unique && !indexed.has(c.name.toLowerCase()));
    if (fks.length) out.push(mk("database", "medium", `fkidx:${t.key}`, `${t.name}: ${fks.length} foreign key${fks.length === 1 ? "" : "s"} without an index`, `Looking up ${t.name} rows by ${list(fks.map((c) => c.name), 4)} scans the whole table, which gets slow as data grows.`, prisma ? `Add ${fks.map((c) => `@@index([${c.name}])`).join(" and ")} to the ${t.name} model and run a migration.` : `Create an index: ${fks.map((c) => `CREATE INDEX ${t.name}_${c.name}_idx ON ${t.name}(${c.name});`).join(" ")}`, { nodeKey: t.key, file: t.file, line: t.lineStart, count: fks.length }));
    const secretCols = cols.filter((c) => SECRET_COL.test(c.name) && !/hash|digest/i.test(c.name));
    if (secretCols.length && touched.get(t.key)?.read) out.push(mk("database", "info", `secretcol:${t.key}`, `${t.name} stores ${list(secretCols.map((c) => c.name), 3)} and an API reads it`, "Columns named like secrets are easy to leak when an endpoint returns whole rows.", "Make sure handlers select only the columns they need (Prisma `select`) and store passwords and tokens hashed, never in plain text.", { nodeKey: `column:${t.name}.${secretCols[0].name}`, file: t.file }));
  }
  const idle = tables.filter((t) => !touched.has(t.key));
  if (idle.length && tables.length > 1) out.push(mk("database", "info", "idle-tables", `${idle.length} table${idle.length === 1 ? "" : "s"} nothing reads or writes`, "No endpoint in the code touches these tables, so they may be leftovers from an old feature or filled by another system.", `Check whether ${list(idle.map((t) => t.name))} ${idle.length === 1 ? "is" : "are"} still needed; drop unused tables with a migration.`, { count: idle.length, nodeKey: idle[0].key }));
  return out;
}
