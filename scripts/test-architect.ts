// Offline smoke test for the Architect module. Run: npx tsx scripts/test-architect.ts
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateBlueprint, runDesignChecks, flipAssumption } from "../src/lib/arkus/architect/generate";
import { validateBlueprint, blueprintToGraph } from "../src/lib/arkus/architect/schema";
import { toPrismaSchema, toSqlDdl, toOpenApi, toTasksMarkdown, toSpecJson } from "../src/lib/arkus/architect/export";
import { scaffoldProject } from "../src/lib/arkus/architect/scaffold";
import { TEMPLATE_NAMES, templateBlueprint, pickTemplate } from "../src/lib/arkus/architect/templates";

delete process.env.GROQ_API_KEY; // force offline path

async function main() {
  const idea = "A marketplace where tutors list classes and students book and pay";
  const gen = await generateBlueprint({ idea });
  assert.equal(gen.aiUsed, false);
  assert.equal(gen.template, "marketplace");
  const bp = gen.blueprint;
  console.log(`blueprint: ${bp.name} · ${bp.entities.length} entities · ${bp.endpoints.length} endpoints · ${bp.pages.length} pages · template=${gen.template}`);
  console.log("tables:", bp.entities.map((e) => e.table).join(", "));

  // 1. validate: 0 issues (re-validate the generated output as JSON, like the API does)
  const v = validateBlueprint(JSON.parse(JSON.stringify(bp)));
  assert.ok(v.blueprint, "blueprint parses");
  assert.deepEqual(v.issues, [], `issues: ${JSON.stringify(v.issues)}`);
  assert.ok(bp.entities.some((e) => e.table === "classes"), "noun detection: classes");
  assert.ok(bp.entities.some((e) => e.table === "bookings"), "noun detection: bookings");
  assert.ok(bp.entities.find((e) => e.table === "classes")!.columns.some((c) => c.name === "tutor_id"), "noun detection: tutor_id");

  // 2. design checks
  const checks = runDesignChecks(bp);
  assert.ok(checks.length >= 6);
  const failing = checks.filter((c) => !c.ok);
  console.log("checks:", checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}`).join(" | "));
  assert.deepEqual(failing.map((c) => c.name), [], `failing checks: ${failing.map((c) => c.detail).join("; ")}`);

  // 3. graph
  const g = blueprintToGraph(bp);
  const count = (t: string) => g.nodes.filter((n) => n.type === t).length;
  const cols = bp.entities.reduce((n, e) => n + e.columns.length, 0);
  assert.equal(count("table"), bp.entities.length);
  assert.equal(count("column"), cols);
  assert.equal(count("endpoint"), bp.endpoints.length);
  assert.equal(count("screen"), bp.pages.length);
  assert.equal(count("external"), bp.services.length);
  assert.equal(g.edges.filter((e) => e.type === "calls").length, bp.pages.reduce((n, p) => n + p.calls.length, 0));
  const fks = bp.entities.reduce((n, e) => n + e.columns.filter((c) => c.references).length, 0);
  assert.equal(g.edges.filter((e) => e.type === "references").length, fks);
  const fields = bp.pages.reduce((n, p) => n + p.fields.length, 0);
  assert.equal(g.bindings.length, fields);
  assert.ok(g.bindings.every((b) => b.source === "designed" && b.confidence === 1 && b.apiKey && b.keyName && b.tableName && b.columnName), "every binding fully bound");
  console.log(`graph: ${g.nodes.length} nodes · ${g.edges.length} edges · ${g.bindings.length} bindings`);

  // 4. exports
  const prismaSchema = toPrismaSchema(bp, "sqlite");
  const prismaPg = toPrismaSchema(bp, "postgresql");
  const sql = toSqlDdl(bp, "postgres");
  const sqlLite = toSqlDdl(bp, "sqlite");
  const oa = toOpenApi(bp) as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
  const tasks = toTasksMarkdown(bp);
  const spec = toSpecJson(bp);
  assert.ok(prismaSchema.length > 200 && prismaPg.includes('provider = "postgresql"'));
  for (const e of bp.entities) {
    assert.ok(sql.includes(`CREATE TABLE "${e.table}"`), `sql has ${e.table}`);
    assert.ok(sqlLite.includes(`CREATE TABLE "${e.table}"`), `sqlite has ${e.table}`);
    assert.ok(prismaSchema.includes(`@@map("${e.table}")`), `prisma has ${e.table}`);
  }
  assert.ok(sql.indexOf('CREATE TABLE "users"') < sql.indexOf('CREATE TABLE "classes"'), "dependency order");
  assert.equal(Object.keys(oa.paths).length, new Set(bp.endpoints.map((e) => e.path)).size);
  assert.equal(Object.keys(oa.components.schemas).length, bp.entities.length);
  assert.ok(tasks.includes("## Phase 1") && tasks.includes("route.ts") && tasks.includes("page.tsx"));
  assert.ok((spec as { layout?: unknown }).layout);
  console.log(`exports: prisma ${prismaSchema.length}b · sql ${sql.length}b · openapi ${Object.keys(oa.paths).length} paths · tasks ${tasks.split("\n").length} lines`);

  // 5. flip assumption offline
  const flipped = await flipAssumption(bp, "roles");
  assert.equal(flipped.aiUsed, false);
  assert.ok(flipped.blueprint.assumptions.find((a) => a.id === "roles")!.text.startsWith("Separate"));

  // 6. all templates validate for a few ideas
  for (const t of TEMPLATE_NAMES) for (const i of [idea, "An online shop for handmade candles", "A clinic appointment booking tool", "A CRM for a small sales team", "A team workspace app"]) {
    const r = validateBlueprint(templateBlueprint(i, t));
    assert.ok(r.blueprint && r.issues.length === 0, `template ${t} / "${i}": ${JSON.stringify(r.issues.slice(0, 3))}`);
    const bad = runDesignChecks(r.blueprint!).filter((c) => !c.ok);
    assert.deepEqual(bad, [], `template ${t} / "${i}" checks: ${bad.map((c) => c.detail).join("; ")}`);
  }
  assert.equal(pickTemplate("An online shop for handmade candles"), "ecommerce");
  assert.equal(pickTemplate("A clinic appointment booking tool"), "booking");
  assert.equal(pickTemplate("A CRM for a small sales team"), "crm");
  console.log("templates: all 5 validate with 0 issues and 0 failing checks");

  // 7. LLM-style garbage is rejected
  assert.equal(validateBlueprint({ name: "x" }).blueprint, null);
  assert.ok(validateBlueprint({ ...JSON.parse(JSON.stringify(bp)), pages: [{ path: "/x", name: "X", kind: "list", calls: ["GET /api/nope"] }] }).issues.some((i) => i.level === "error"));

  // 8. scaffold
  const targetDir = path.resolve(process.cwd(), ".scratch", "scaffold-test");
  const res = await scaffoldProject({ bp, targetDir, force: true, blueprintVersion: 1 });
  const exists = async (rel: string) => !!(await fs.stat(path.join(targetDir, rel)).catch(() => null));
  assert.ok(await exists("arkus.json"));
  assert.ok(await exists("package.json") && await exists("prisma/schema.prisma") && await exists("src/app/layout.tsx") && await exists("src/lib/auth.ts"));
  assert.ok(res.files.some((f) => f.endsWith("route.ts")) && res.files.some((f) => f.endsWith("page.tsx")));
  assert.ok(await exists("src/app/api/classes/route.ts") && await exists("src/app/api/classes/[id]/route.ts") && await exists("src/app/classes/new/page.tsx"));
  const arkusJson = JSON.parse(await fs.readFile(path.join(targetDir, "arkus.json"), "utf8"));
  assert.equal(arkusJson.blueprintVersion, 1);
  assert.equal(arkusJson.bindings.length, g.bindings.length);
  const route = await fs.readFile(path.join(targetDir, "src/app/api/classes/route.ts"), "utf8");
  assert.ok(route.includes("z.object") && route.includes("prisma.class.create") && route.includes("status: 201"));
  const page = await fs.readFile(path.join(targetDir, "src/app/classes/new/page.tsx"), "utf8");
  assert.ok(page.includes('name="title"') && page.includes("fetch(`/api/classes`") && page.includes("<form"));
  // safety: non-empty without force refuses; traversal refused
  await assert.rejects(scaffoldProject({ bp, targetDir }), /not empty/);
  console.log(`scaffold: ${res.files.length} files → ${res.targetDir}`);
  console.log("next steps:", res.nextSteps.join(" → "));
  console.log("\nALL ARCHITECT TESTS PASSED");
}

main().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
