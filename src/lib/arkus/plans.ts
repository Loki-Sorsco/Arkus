// Plans: the only way anything changes. A plan bundles changes by layer (PAGE / API / DB), the
// impact report, forward + reverse migration, checks with evidence, and a hand-off guide
// (Free path: Arkus tells you exactly what to change; it never edits your repo itself in V1).
import { prisma, j } from "../db";
import { chatText, untrusted } from "../llm";
import { impactOf, loadGraph, type LoadedGraph } from "./graph";
import { humanize } from "./resolve";
import type { GNode } from "./types";

export type ChangeRow = { layer: "PAGE" | "API" | "DB"; op: "add" | "modify" | "remove"; target: string; detail: string; file?: string; line?: number };
export type Check = { name: string; status: "pass" | "warn" | "fail" | "pending"; evidence: string };
export type PlanIntent =
  | { kind: "add_column"; table: string; column: string; type: string; nullable?: boolean; default?: string; alsoExposeOn?: string[] }
  | { kind: "add_field"; page: string; label: string; uiType: string; required?: boolean; key?: string; column?: string; table?: string; frontendOnly?: boolean; computed?: string }
  | { kind: "add_endpoint"; method: string; path: string; description?: string; bodyKeys?: { name: string; type: string; required?: boolean }[]; tables?: string[] }
  | { kind: "edit_writeup"; endpoint: string; before: string; after: string }
  | { kind: "data_edit"; table: string; sql: string; rows: number; before: unknown[]; after: unknown[] }
  | { kind: "custom"; title: string; changes: ChangeRow[] };

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
const sqlType = (t: string) => ({ text: "text", string: "text", email: "text", phone: "text", number: "numeric", integer: "integer", int: "integer", date: "date", datetime: "timestamptz", timestamptz: "timestamptz", boolean: "boolean", "yes/no": "boolean", bool: "boolean", uuid: "uuid", json: "jsonb", jsonb: "jsonb" }[t.toLowerCase()] || "text");
const prismaType = (t: string) => ({ text: "String", integer: "Int", numeric: "Decimal", date: "DateTime", timestamptz: "DateTime", boolean: "Boolean", uuid: "String", jsonb: "Json" }[sqlType(t)] || "String");

function findNode(g: LoadedGraph, pred: (n: GNode) => boolean) { return g.nodes.find(pred); }

/** Build the structured plan (changes, migration, checks, impact, guide) from an intent. */
export async function buildPlan(projectId: string, intent: PlanIntent) {
  const g = await loadGraph(projectId);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const stack = j<{ orms?: string[]; frameworks?: string[]; dbEngineHint?: string }>(project.stack, {});
  const usesPrisma = stack.orms?.includes("prisma");
  const changes: ChangeRow[] = [];
  const checks: Check[] = [];
  let title = "";
  let migrationFwd: string | null = null, migrationRev: string | null = null;
  let impact: ReturnType<typeof impactOf> | Record<string, never> = {};
  let decisions: Record<string, unknown> = {};
  const suggested: string[] = [];

  if (intent.kind === "add_field" || intent.kind === "add_column") {
    // Cascade planner: one new field → PAGE + API + DB rows in one plan.
    const page = intent.kind === "add_field" ? findNode(g, (n) => n.type === "screen" && (n.key === intent.page || n.name === intent.page)) : undefined;
    const label = intent.kind === "add_field" ? intent.label : humanize(intent.column);
    const key = intent.kind === "add_field" ? (intent.key || snake(intent.label)) : intent.column;
    const uiType = intent.kind === "add_field" ? intent.uiType : intent.type;
    const colType = sqlType(uiType);
    // which endpoint does the page submit to?
    // The page's submit endpoint: the one most of its bindings point at, else its first write call, else any call.
    const byBindings = page ? Object.entries(g.bindings.filter((b) => b.pageKey === page.key && b.apiKey).reduce<Record<string, number>>((acc, b) => { acc[b.apiKey!] = (acc[b.apiKey!] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    const endpointKey = byBindings || (page ? g.edges.find((e) => e.from === page.key && e.type === "calls" && g.nodes.find((n) => n.key === e.to)?.attrs?.method !== "GET")?.to || g.edges.find((e) => e.from === page.key && e.type === "calls")?.to : undefined);
    const endpoint = endpointKey ? findNode(g, (n) => n.key === endpointKey) : undefined;
    const tableName = intent.kind === "add_column" ? intent.table : intent.table || (endpoint ? g.edges.filter((e) => e.from === endpoint.key && e.type === "writes").map((e) => g.nodes.find((n) => n.key === e.to)?.name).find(Boolean) : undefined);
    const table = tableName ? findNode(g, (n) => n.type === "table" && n.name === tableName) : undefined;
    const frontendOnly = intent.kind === "add_field" && (intent.frontendOnly || /confirm/i.test(label));
    const computed = intent.kind === "add_field" ? intent.computed : undefined;
    title = intent.kind === "add_field" ? `Add "${label}" to ${page?.name || intent.page}` : `Add ${tableName}.${key}`;

    if (page) changes.push({ layer: "PAGE", op: "add", target: page.name, detail: `${uiType} field "${label}"${intent.kind === "add_field" && intent.required ? " · required" : ""}${frontendOnly ? " · frontend only" : ""}`, file: page.file });
    if (table && (table.attrs?.columns as { name: string }[] | undefined)?.some((c) => c.name === key)) {
      checks.push({ name: "Field doesn't already exist", status: "fail", evidence: `${tableName}.${key} already exists — link to it instead?` });
    }
    if (!frontendOnly && !computed) {
      if (endpoint) changes.push({ layer: "API", op: "modify", target: endpoint.name, detail: `accept "${key}" (${colType}${intent.kind === "add_field" && intent.required ? " · required" : " · optional"}) in the request body and store it`, file: endpoint.file, line: endpoint.lineStart });
      if (table) {
        changes.push({ layer: "DB", op: "add", target: `${tableName}.${key}`, detail: `${colType} column${intent.kind === "add_column" && intent.nullable === false ? " NOT NULL" : " · nullable"}`, file: table.file, line: table.lineStart });
        const rows = Number(table.attrs?.rowEstimate ?? 0);
        const notNull = intent.kind === "add_column" && intent.nullable === false;
        if (rows > 0 && notNull) decisions = { existingRows: { rows, options: ["nullable in DB + required in form (recommended)", "fill a default", "NOT NULL everywhere (needs backfill)"], chosen: 0 } };
        checks.push({ name: "Existing data is compatible", status: rows > 0 && notNull ? "warn" : "pass", evidence: rows > 0 ? `${rows.toLocaleString()} existing rows in ${tableName} have no ${key}${notNull ? " — adding NOT NULL would fail; make it nullable or give it a default" : " (nullable column: fine)"}` : `${tableName} is empty or row count unknown` });
        const dflt = intent.kind === "add_column" && intent.default ? ` DEFAULT ${intent.default}` : "";
        migrationFwd = `-- expand: add the column (nullable so existing rows keep working)\nALTER TABLE "${tableName}" ADD COLUMN "${key}" ${colType}${dflt}${notNull && !rows ? " NOT NULL" : ""};`;
        migrationRev = `ALTER TABLE "${tableName}" DROP COLUMN "${key}";`;
        if (usesPrisma) migrationFwd += `\n\n-- prisma/schema.prisma (model ${table.attrs?.modelName || tableName}):\n  ${key} ${prismaType(uiType)}${notNull ? "" : "?"}${intent.kind === "add_column" && intent.default ? ` @default(${intent.default})` : ""}`;
        // also suggested: GET endpoints that return this table
        for (const e of g.edges.filter((e) => e.to === table.key && e.type === "reads")) { const ep = g.nodes.find((n) => n.key === e.from); if (ep?.attrs?.method === "GET") suggested.push(`${ep.name} also returns ${key}`); }
      } else if (endpoint) {
        checks.push({ name: "Every API key has a column", status: "warn", evidence: `couldn't find the table ${endpoint.name} writes to — pick one` });
      } else if (page) {
        checks.push({ name: "Every form field has an API key", status: "warn", evidence: `${page.name} doesn't submit to a known endpoint` });
      }
    }
    if (computed) changes.push({ layer: "API", op: "modify", target: endpoint?.name || "response", detail: `computed: ${computed}` });
    if (table) impact = impactOf(g, table.key);
    checks.push({ name: "Every form field has an API key", status: frontendOnly || computed || endpoint ? "pass" : "warn", evidence: frontendOnly ? `"${label}" stays in the browser` : endpoint ? `"${label}" → ${key} on ${endpoint.name}` : "no endpoint" });
    checks.push({ name: "Every API key has a column", status: frontendOnly || computed || table ? "pass" : "warn", evidence: table ? `${key} → ${tableName}.${key}` : computed ? "computed, not stored" : "no column" });
    if (migrationRev) checks.push({ name: "Reverse migration generated", status: "pass", evidence: migrationRev });
  } else if (intent.kind === "add_endpoint") {
    title = `Add ${intent.method} ${intent.path}`;
    changes.push({ layer: "API", op: "add", target: `${intent.method} ${intent.path}`, detail: intent.description || `${(intent.bodyKeys || []).length} request keys` });
    for (const t of intent.tables || []) { const tn = findNode(g, (n) => n.type === "table" && n.name === t); changes.push({ layer: "DB", op: "modify", target: t, detail: `${intent.method === "GET" ? "reads" : "writes"} ${t}`, file: tn?.file }); }
    checks.push({ name: "Access rules cover the route", status: "pending", evidence: "add auth middleware or mark it public" });
  } else if (intent.kind === "edit_writeup") {
    const ep = findNode(g, (n) => n.key === intent.endpoint);
    title = `Update ${ep?.name || intent.endpoint} from writeup`;
    changes.push({ layer: "API", op: "modify", target: ep?.name || intent.endpoint, detail: `behaviour change: "${intent.after}"`, file: ep?.file, line: ep?.lineStart });
    if (ep) impact = impactOf(g, ep.key);
  } else if (intent.kind === "data_edit") {
    title = `Edit ${intent.rows} row${intent.rows === 1 ? "" : "s"} in ${intent.table}`;
    changes.push({ layer: "DB", op: "modify", target: intent.table, detail: intent.sql });
    migrationFwd = intent.sql;
    checks.push({ name: "Rows still match what you saw", status: "pending", evidence: "optimistic check runs at write time" });
  } else {
    title = intent.title;
    changes.push(...intent.changes);
  }
  const risk = "risk" in impact ? impact.risk : "low";
  return { title, changes, checks, impact, migrationFwd, migrationRev, decisions, suggested, risk, intent };
}

export async function createPlan(projectId: string, intent: PlanIntent, env = "dev") {
  const built = await buildPlan(projectId, intent);
  const last = await prisma.plan.findFirst({ where: { projectId }, orderBy: { no: "desc" } });
  const no = (last?.no || 0) + 1;
  const guide = await handoffGuide(projectId, built, no);
  const plan = await prisma.plan.create({ data: { projectId, no, title: built.title, pipeline: "draft", changes: JSON.stringify(built.changes), decisions: JSON.stringify({ ...built.decisions, intent, suggested: built.suggested }), migrationFwd: built.migrationFwd, migrationRev: built.migrationRev, impact: JSON.stringify(built.impact), checks: JSON.stringify(built.checks), guide, risk: built.risk, env, branch: `arkus/plan-${no}`, comments: "[]" } });
  await prisma.activity.create({ data: { projectId, env, kind: "plan", what: `Plan #${no} drafted: ${built.title}`, meta: JSON.stringify({ planNo: no }) } });
  return plan;
}

/** Free path: a precise, file-by-file change guide (and a copy-ready prompt for the user's AI). */
export async function handoffGuide(projectId: string, built: Awaited<ReturnType<typeof buildPlan>>, no: number) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const lines: string[] = [`# Plan #${no} — ${built.title}`, "", "## Summary", `${built.changes.length} change${built.changes.length === 1 ? "" : "s"} across ${[...new Set(built.changes.map((c) => c.layer))].join(" / ")}. ${"summary" in built.impact ? built.impact.summary + "." : ""}`, "", "## Where to change"];
  built.changes.forEach((c, i) => lines.push(`${i + 1}. **${c.layer}** · ${c.target}${c.file ? ` — \`${c.file}${c.line ? `:${c.line}` : ""}\`` : ""}  \n   ${c.detail}`));
  if (built.migrationFwd) lines.push("", "## Migration (forward)", "```sql", built.migrationFwd, "```");
  if (built.migrationRev) lines.push("", "## Rollback", "```sql", built.migrationRev, "```");
  if (built.suggested.length) lines.push("", "## Also suggested", ...built.suggested.map((s) => `- ${s}`));
  lines.push("", "## Rollout", "1. Apply on dev, run the app's tests.", "2. Expand → migrate → contract: add nullable first, backfill, then tighten constraints in a later plan.", "3. After you push, re-index in Arkus to verify the change landed.");
  let md = lines.join("\n");
  // Optional: let the LLM add concrete code snippets, bounded by the deterministic plan.
  const extra = await chatText(
    "You are a senior engineer writing a precise hand-off for a code change in the user's own repo. Output markdown with a '## Suggested code' section containing minimal snippets per file listed; never invent files not listed; keep it under 60 lines.",
    `${untrusted("plan", md)}\n\nStack: ${project.stack}`,
    { fast: true, maxTokens: 1200 },
  );
  if (extra && /##\s*Suggested code/i.test(extra)) md += "\n\n" + extra.slice(extra.search(/##\s*Suggested code/i));
  md += `\n\n## Copy as AI prompt\n\`\`\`\nIn the repo at ${project.rootPath || "(repo)"}, implement Arkus Plan #${no} "${built.title}":\n${built.changes.map((c) => `- [${c.layer}] ${c.target}: ${c.detail}${c.file ? ` (${c.file})` : ""}`).join("\n")}\n${built.migrationFwd ? `Migration:\n${built.migrationFwd}\n` : ""}Keep changes minimal, add tests, do not touch unrelated files.\n\`\`\``;
  return md;
}

/** Re-run the deterministic checks (e.g. after a re-index) and move the pipeline forward. */
export async function previewPlan(projectId: string, no: number) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { projectId_no: { projectId, no } } });
  const decisions = j<{ intent?: PlanIntent }>(plan.decisions, {});
  let checks = j<Check[]>(plan.checks, []);
  if (decisions.intent) { const built = await buildPlan(projectId, decisions.intent); checks = built.checks; }
  const failing = checks.some((c) => c.status === "fail");
  const pipeline = failing ? "failed" : "checks_passing";
  return prisma.plan.update({ where: { id: plan.id }, data: { pipeline, checks: JSON.stringify(checks) } });
}

/** Verify after the user pushed: does the current graph contain the planned changes? */
export async function verifyPlan(projectId: string, no: number) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { projectId_no: { projectId, no } } });
  const g = await loadGraph(projectId);
  const changes = j<ChangeRow[]>(plan.changes, []);
  const results = changes.map((c) => {
    let done = false;
    if (c.layer === "DB" && c.op === "add") { const [t, col] = c.target.split("."); const tn = g.nodes.find((n) => n.type === "table" && n.name === t); done = !!(tn?.attrs?.columns as { name: string }[] | undefined)?.some((x) => x.name === col); }
    else if (c.layer === "API" && c.op === "add") done = g.nodes.some((n) => n.type === "endpoint" && n.name === c.target);
    else if (c.layer === "PAGE" && c.op === "add") { const m = c.detail.match(/"([^"]+)"/); const pg = g.nodes.find((n) => n.type === "screen" && n.name === c.target); done = !!m && !!(pg?.attrs?.fields as { label: string }[] | undefined)?.some((f) => f.label.toLowerCase() === m[1].toLowerCase()); }
    else if (c.layer === "API" && c.op === "modify") { const m = c.detail.match(/accept "([^"]+)"/); const ep = g.nodes.find((n) => n.type === "endpoint" && n.name === c.target); done = !m || !!(ep?.attrs?.bodyKeys as { name: string }[] | undefined)?.some((b) => b.name === m[1]); }
    return { ...c, done };
  });
  const all = results.length > 0 && results.every((r) => r.done);
  const updated = await prisma.plan.update({ where: { id: plan.id }, data: { pipeline: all ? "shipped" : plan.pipeline, decisions: JSON.stringify({ ...j(plan.decisions, {}), verify: results }) } });
  if (all) await prisma.activity.create({ data: { projectId, env: plan.env, kind: "plan", what: `Plan #${no} verified in repo — shipped`, meta: JSON.stringify({ planNo: no }) } });
  return { plan: updated, results, done: results.filter((r) => r.done).length, total: results.length };
}
