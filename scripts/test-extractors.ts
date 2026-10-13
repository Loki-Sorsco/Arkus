// Runs the static extractors over fixtures/* and asserts the expected facts.
// Run (node is Windows-side on this machine):
//   powershell.exe -NoProfile -Command "cd C:\Users\dell\Downloads\arkus; npx tsx scripts/test-extractors.ts"
import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import type { Detected, ExtractContext, Extractor, Facts, RepoFile } from "../src/lib/arkus/types";
import { emptyFacts } from "../src/lib/arkus/types";
import { openapiExtractor } from "../src/lib/arkus/extractors/openapi";
import { sqlMigrationsExtractor } from "../src/lib/arkus/extractors/sql-migrations";
import { nextjsExtractor } from "../src/lib/arkus/extractors/nextjs";
import { nodeRoutesExtractor } from "../src/lib/arkus/extractors/node-routes";
import { pythonExtractor } from "../src/lib/arkus/extractors/python";
import { callersExtractor } from "../src/lib/arkus/extractors/callers";
import { ormUsageExtractor } from "../src/lib/arkus/extractors/orm-usage";
import { externalsExtractor } from "../src/lib/arkus/extractors/externals";

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
let failures = 0;

function detect(files: RepoFile[], pkg: Record<string, unknown> | undefined, reqs: string): Detected {
  const deps = Object.keys({ ...(pkg?.dependencies as object ?? {}), ...(pkg?.devDependencies as object ?? {}) });
  const frameworks: string[] = [], orms: string[] = [], languages = new Set<string>();
  for (const f of files) if (["ts", "tsx", "js", "jsx"].includes(f.ext)) languages.add(f.ext.startsWith("t") ? "ts" : "js"); else if (f.ext === "py") languages.add("py");
  if (deps.includes("next")) frameworks.push("nextjs"); if (deps.includes("express")) frameworks.push("express"); if (deps.includes("react")) frameworks.push("react");
  if (deps.includes("@prisma/client")) orms.push("prisma");
  if (/fastapi/.test(reqs)) frameworks.push("fastapi"); if (/sqlalchemy/i.test(reqs)) orms.push("sqlalchemy");
  return { languages: [...languages], frameworks, orms, apps: [], summary: frameworks.join(" · ") };
}

async function contextFor(dir: string): Promise<ExtractContext> {
  const rels = await fg(["**/*"], { cwd: dir, dot: true, onlyFiles: true, ignore: ["**/node_modules/**"] });
  const files: RepoFile[] = [];
  for (const rel of rels.sort()) { const abs = path.join(dir, rel); const st = await fs.stat(abs); files.push({ rel, abs, size: st.size, ext: path.extname(rel).slice(1).toLowerCase() }); }
  let pkg: Record<string, unknown> | undefined; try { pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")); } catch { /* none */ }
  let reqs = ""; try { reqs = await fs.readFile(path.join(dir, "requirements.txt"), "utf8"); } catch { /* none */ }
  const cache = new Map<string, string>();
  return {
    root: dir, files, det: detect(files, pkg, reqs),
    async read(rel) { if (!cache.has(rel)) cache.set(rel, await fs.readFile(path.join(dir, rel), "utf8")); return cache.get(rel)!; },
    log(msg, level = "info") { if (VERBOSE || level !== "info") console.log(`    [${level}] ${msg}`); },
  };
}

async function runAll(ctx: ExtractContext, list: Extractor[]): Promise<Facts> {
  const facts = emptyFacts();
  for (const ex of list) {
    if (!ex.applies(ctx.det, ctx.files)) { if (VERBOSE) console.log(`    (skip ${ex.name})`); continue; }
    const t0 = Date.now();
    const part = await ex.run(ctx);
    for (const k of Object.keys(part) as (keyof Facts)[]) (facts[k] as unknown[]).push(...((part[k] ?? []) as unknown[]));
    if (VERBOSE) console.log(`    ${ex.name}: ${Date.now() - t0}ms`);
  }
  return facts;
}

function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail !== undefined ? " → " + JSON.stringify(detail) : ""}`); }
}
const route = (f: Facts, m: string, p: string) => f.routes.find((r) => r.method === m && r.path === p);
const call = (f: Facts, m: string, p: string) => f.apicalls.find((r) => r.method === m && r.path === p);
const table = (f: Facts, n: string) => f.tables.find((t) => t.name === n);
const names = (xs?: { name: string }[]) => (xs ?? []).map((x) => x.name).sort();

function print(f: Facts) {
  console.log("  routes:   " + f.routes.map((r) => `${r.method} ${r.path} [${r.framework}${r.auth === true ? " auth" : ""}${r.bodyKeys?.length ? " body=" + names(r.bodyKeys).join(",") : ""} c=${r.confidence}] @${r.file}:${r.line}`).join("\n            "));
  console.log("  screens:  " + f.screens.map((s) => `${s.path} fields=${(s.fields ?? []).map((x) => `${x.name ?? "?"}:${x.uiType}${x.required ? "!" : ""}("${x.label}")`).join(",")} uses=${(s.componentsUsed ?? []).join(",")}`).join("\n            "));
  console.log("  apicalls: " + f.apicalls.map((c) => `${c.method} ${c.path} [${c.lib}${c.dynamic ? " dyn" : ""}${c.bodyKeys?.length ? " body=" + c.bodyKeys.join(",") : ""}] @${c.fromFile}:${c.line}`).join("\n            "));
  console.log("  tables:   " + f.tables.map((t) => `${t.name}(${t.source}) ${t.columns.map((c) => `${c.name}:${c.type}${c.pk ? " pk" : ""}${c.unique ? " uq" : ""}${c.nullable === false ? " nn" : ""}${c.references ? " →" + c.references.table + "." + c.references.column : ""}${c.index ? " ix" : ""}`).join(", ")}`).join("\n            "));
  console.log("  orm:      " + f.ormUsage.map((u) => `${u.op} ${u.table} via ${u.via} @${u.file}:${u.line}`).join("\n            "));
  console.log("  external: " + f.externals.map((e) => `${e.name} (${e.evidence}) @${e.file}`).join("\n            "));
}

const mine: Extractor[] = [openapiExtractor, sqlMigrationsExtractor, nextjsExtractor, nodeRoutesExtractor, pythonExtractor, callersExtractor, ormUsageExtractor, externalsExtractor];

async function main() {
  // include the prisma extractor when it is present (written separately)
  let list = mine;
  try { const idx = await import("../src/lib/arkus/extractors/index"); list = idx.extractors; console.log(`using extractors/index.ts: ${list.map((e) => e.name).join(", ")}`); }
  catch (e) { console.log(`extractors/index.ts not loadable (${(e as Error).message.split("\n")[0]}); running own extractors only`); }

  // ---------- next-prisma ----------
  {
    console.log("\n== fixtures/next-prisma ==");
    const f = await runAll(await contextFor(path.join(FIXTURES, "next-prisma")), list);
    print(f);
    check("GET /api/orders/:id (nextjs-app)", route(f, "GET", "/api/orders/:id")?.framework === "nextjs-app");
    check("DELETE /api/orders/:id", !!route(f, "DELETE", "/api/orders/:id"));
    const co = route(f, "POST", "/api/checkout");
    check("POST /api/checkout bodyKeys email,amount", !!co && names(co.bodyKeys).join(",") === "amount,email", names(co?.bodyKeys));
    check("POST /api/checkout confidence 1, file+line", co?.confidence === 1 && co.file === "app/api/checkout/route.ts" && co.line === 8, co?.line);
    const act = route(f, "POST", "/_action/createOrder");
    check("server action /_action/createOrder bodyKeys email", act?.framework === "server-action" && names(act.bodyKeys).includes("email"), act);
    const sc = f.screens.find((s) => s.path === "/checkout");
    check("screen /checkout", !!sc);
    check("screen / (home)", f.screens.some((s) => s.path === "/"));
    const fld = (n: string) => sc?.fields?.find((x) => x.name === n);
    check("field email: uiType email, required, label from <label htmlFor>", fld("email")?.uiType === "email" && fld("email")?.required === true && fld("email")?.label === "Email address", fld("email"));
    check("field card: label from enclosing <label>", fld("card")?.label === "Card number", fld("card"));
    check("field amount: number, label from placeholder", fld("amount")?.uiType === "number" && fld("amount")?.label === "Amount", fld("amount"));
    check("field currency: select", fld("currency")?.uiType === "select", fld("currency"));
    check("componentsUsed resolves @/components/OrderSummary", (sc?.componentsUsed ?? []).includes("components/OrderSummary.tsx"), sc?.componentsUsed);
    const c1 = call(f, "POST", "/api/checkout");
    check("apicall POST /api/checkout from page with bodyKeys email,amount", c1?.fromFile === "app/checkout/page.tsx" && [...(c1.bodyKeys ?? [])].sort().join(",") === "amount,email" && c1.lib === "fetch", c1);
    const c2 = call(f, "GET", "/api/orders/:param");
    check("apicall useSWR template → /api/orders/:param dynamic, lib swr", c2?.lib === "swr" && c2.dynamic === true && c2.fromFile === "components/OrderSummary.tsx", c2);
    check("orm: prisma order write in checkout route", f.ormUsage.some((u) => u.via === "prisma" && u.table === "order" && u.op === "write" && u.file === "app/api/checkout/route.ts"));
    check("orm: prisma user read in checkout route", f.ormUsage.some((u) => u.via === "prisma" && u.table === "user" && u.op === "read"));
    check("orm: prisma order read in orders/[id] route", f.ormUsage.some((u) => u.via === "prisma" && u.table === "order" && u.op === "read" && u.file.includes("orders/[id]")));
    check("external stripe via import and env", f.externals.some((e) => e.name === "stripe" && e.evidence === "import:stripe") && f.externals.some((e) => e.name === "stripe" && e.evidence === "env:STRIPE_SECRET_KEY"));
    if (list.some((e) => e.name.includes("prisma"))) check("prisma tables User/Order present (prisma extractor)", f.tables.some((t) => t.source === "prisma" && t.modelName === "User") && f.tables.some((t) => t.source === "prisma" && t.modelName === "Order"), f.tables.map((t) => t.name));
  }

  // ---------- express-sql ----------
  {
    console.log("\n== fixtures/express-sql ==");
    const f = await runAll(await contextFor(path.join(FIXTURES, "express-sql")), list);
    print(f);
    check("GET /api/orders (prefix resolved from app.use in another file, c=0.8)", route(f, "GET", "/api/orders")?.confidence === 0.8, route(f, "GET", "/api/orders"));
    const byId = route(f, "GET", "/api/orders/:id");
    check("GET /api/orders/:id auth=true (requireAuth)", byId?.auth === true, byId);
    const post = route(f, "POST", "/api/orders");
    check("POST /api/orders bodyKeys email,amount + auth", !!post && names(post.bodyKeys).join(",") === "amount,email" && post.auth === true, post);
    check("GET /health (express, c=1)", route(f, "GET", "/health")?.confidence === 1);
    check("no axios calls mistaken for routes", !f.routes.some((r) => r.file.startsWith("client/")), f.routes.filter((r) => r.file.startsWith("client/")));
    const users = table(f, "users"), orders = table(f, "orders");
    check("table users: id pk autoincrement, email unique not null", users?.columns.find((c) => c.name === "id")?.pk === true && users?.columns.find((c) => c.name === "email")?.unique === true && users?.columns.find((c) => c.name === "email")?.nullable === false, users);
    check("table users: created_at dropped by ALTER", !!users && !users.columns.some((c) => c.name === "created_at"), users?.columns.map((c) => c.name));
    check("table orders: user_id → users.id", orders?.columns.find((c) => c.name === "user_id")?.references?.table === "users", orders);
    check("table orders: email added by ALTER, index on user_id, status default pending", !!orders?.columns.find((c) => c.name === "email") && orders?.columns.find((c) => c.name === "user_id")?.index === true && orders?.columns.find((c) => c.name === "status")?.default === "pending", orders);
    check("table temp_stuff dropped", !table(f, "temp_stuff"));
    check("apicall GET /api/orders via axios instance baseURL", call(f, "GET", "/api/orders")?.lib === "axios", f.apicalls);
    check("apicall POST /api/orders bodyKeys email,amount", [...(call(f, "POST", "/api/orders")?.bodyKeys ?? [])].sort().join(",") === "amount,email", call(f, "POST", "/api/orders"));
    check("apicall GET /api/orders/:param dynamic", call(f, "GET", "/api/orders/:param")?.dynamic === true);
    check("orm: SQL read orders + users (JOIN)", f.ormUsage.some((u) => u.via === "sql" && u.table === "orders" && u.op === "read") && f.ormUsage.some((u) => u.via === "sql" && u.table === "users" && u.op === "read"));
    check("orm: SQL write orders (INSERT)", f.ormUsage.some((u) => u.via === "sql" && u.table === "orders" && u.op === "write"));
    check("externals: stripe + sendgrid from .env.example, passport from import", f.externals.some((e) => e.name === "stripe" && e.file === ".env.example") && f.externals.some((e) => e.name === "sendgrid") && f.externals.some((e) => e.name === "passport"));
  }

  // ---------- fastapi ----------
  {
    console.log("\n== fixtures/fastapi ==");
    const f = await runAll(await contextFor(path.join(FIXTURES, "fastapi")), list);
    print(f);
    const get = route(f, "GET", "/api/items/:item_id");
    check("GET /api/items/:item_id (include_router + APIRouter prefix, auth via Depends(get_current_user))", get?.framework === "fastapi" && get.auth === true && get.confidence === 0.8, get);
    check("GET /api/items/:item_id description from docstring", get?.description === "Fetch a single item.", get?.description);
    const post = route(f, "POST", "/api/items");
    check("POST /api/items bodyKeys from pydantic ItemCreate", !!post && names(post.bodyKeys).join(",") === "description,name,price" && post.bodyKeys?.find((k) => k.name === "description")?.required === false && post.bodyKeys?.find((k) => k.name === "name")?.required === true, post);
    check("GET /health (app-level)", route(f, "GET", "/health")?.confidence === 1);
    const items = table(f, "items");
    check("table items (sqlalchemy): owner_id → users.id, name not null", items?.source === "sqlalchemy" && items.columns.find((c) => c.name === "owner_id")?.references?.table === "users" && items.columns.find((c) => c.name === "name")?.nullable === false, items);
    check("table users (sqlalchemy): email unique", table(f, "users")?.columns.find((c) => c.name === "email")?.unique === true);
    check("orm: sqlalchemy Item read", f.ormUsage.some((u) => u.via === "sqlalchemy" && u.table === "Item" && u.op === "read"));
    check("orm: sqlalchemy Item write (session.add)", f.ormUsage.some((u) => u.via === "sqlalchemy" && u.table === "Item" && u.op === "write"));
    const pets = route(f, "POST", "/pets");
    check("openapi.yaml: POST /pets bodyKeys name(required),tag + auth", pets?.framework === "openapi" && names(pets.bodyKeys).join(",") === "name,tag" && pets.bodyKeys?.find((k) => k.name === "name")?.required === true && pets.auth === true, pets);
    check("openapi.yaml: GET /pets responseKeys via allOf/$ref", names(route(f, "GET", "/pets")?.responseKeys).join(",") === "id,name,tag", route(f, "GET", "/pets")?.responseKeys);
    check("openapi.yaml: GET /pets/:petId", !!route(f, "GET", "/pets/:petId"));
  }

  console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nall assertions passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
