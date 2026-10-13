// Idea → Blueprint. LLM first (validated with zod), deterministic template fallback so the flow works offline.
import { chatJSON, aiReady, untrusted } from "@/lib/llm";
import { validateBlueprint, endpointRef, parseColumnRef, type Blueprint, type Check, type Issue } from "./schema";
import { templateBlueprint, pickTemplate, type TemplateName } from "./templates";

export const BLUEPRINT_SHAPE = `{
  "name": "string", "summary": "one paragraph",
  "stack": { "frontend": "", "backend": "", "database": "", "auth": "", "payments": "optional", "hosting": "", "reasons": ["why"] },
  "entities": [{ "name": "User", "table": "users", "description": "", "columns": [{ "name": "id", "type": "uuid", "nullable": false, "pk": true, "default": "gen_random_uuid()" }, { "name": "email", "type": "text", "nullable": false, "unique": true }, { "name": "org_id", "type": "uuid", "nullable": false, "references": { "table": "orgs", "column": "id" } }, { "name": "created_at", "type": "timestamptz", "nullable": false, "default": "now()" }], "indexes": [{ "columns": ["email"], "unique": true }] }],
  "endpoints": [{ "method": "POST", "path": "/api/things", "name": "Create thing", "description": "", "auth": true, "internal": false, "request": [{ "key": "title", "type": "string", "required": true, "validation": "min(1)", "fromField": "title" }], "response": [{ "key": "id", "type": "string" }], "reads": ["users"], "writes": ["things"] }],
  "pages": [{ "path": "/things/new", "name": "New thing", "kind": "form", "fields": [{ "label": "Title", "key": "title", "uiType": "text", "required": true, "endpoint": "POST /api/things", "column": "things.title" }], "calls": ["POST /api/things"] }],
  "services": [{ "name": "stripe", "purpose": "" }],
  "jobs": [{ "name": "nightly_cleanup", "schedule": "daily 02:00", "purpose": "" }],
  "assumptions": [{ "id": "roles", "text": "what you assumed", "alternative": "the other option", "chosen": true }],
  "checks": []
}`;

const RULES = `Rules:
1. snake_case for every table, column, request key and page field key. Column types only: text|integer|numeric|boolean|timestamptz|uuid|jsonb|date.
2. Every form page field maps to an endpoint request key (field.endpoint = "METHOD /path", key identical to request.key) AND to a column (field.column = "table.column") that exists.
3. Every table has "id" uuid pk and "created_at" timestamptz. Foreign keys use references {table, column:"id"}. page.calls / endpoint.reads / endpoint.writes only name endpoints / tables that exist in this JSON.
Page kinds: form|display|list|auth. uiType: text|email|password|number|date|select|checkbox|textarea|hidden. Paths with params use :id. Keep it to 4-8 entities, 8-20 endpoints, 6-14 pages.`;

const SYSTEM = `You are a senior software architect. Turn a product idea into a concrete, buildable blueprint for a Next.js 16 + Prisma app. Output a single JSON object matching exactly this schema (no extra keys, no prose):\n${BLUEPRINT_SHAPE}\n${RULES}`;

export type GenerateInput = { idea: string; answers?: Record<string, string>; stackHint?: string };
export type GenerateResult = { blueprint: Blueprint; checks: Check[]; aiUsed: boolean; template?: TemplateName; issues: Issue[] };

function ideaBlock(input: GenerateInput) {
  const answers = Object.entries(input.answers ?? {}).map(([q, a]) => `- ${q}: ${a}`).join("\n");
  return [untrusted("idea", input.idea), answers ? `Answers to follow-up questions:\n${untrusted("answers", answers)}` : "", input.stackHint ? `Preferred stack: ${untrusted("stack", input.stackHint)}` : ""].filter(Boolean).join("\n\n");
}

/** Accept LLM output only when it parses and has no referential errors; otherwise null. */
function accept(json: unknown): { bp: Blueprint; issues: Issue[] } | null {
  if (!json || typeof json !== "object") return null;
  const { blueprint, issues } = validateBlueprint(json);
  if (!blueprint || issues.some((i) => i.level === "error")) {
    console.error("architect: LLM blueprint rejected", issues.slice(0, 5));
    return null;
  }
  return { bp: blueprint, issues };
}

export function offlineBlueprint(idea: string, template?: TemplateName): { bp: Blueprint; template: TemplateName; issues: Issue[] } {
  const t = template ?? pickTemplate(idea);
  const { blueprint, issues } = validateBlueprint(templateBlueprint(idea, t));
  if (!blueprint) throw new Error(`template ${t} is invalid: ${issues.map((i) => i.where + " " + i.message).join("; ")}`);
  return { bp: blueprint, template: t, issues };
}

export async function generateBlueprint(input: GenerateInput): Promise<GenerateResult> {
  if (await aiReady()) {
    const json = await chatJSON<unknown>(SYSTEM, `Design the blueprint for this idea.\n\n${ideaBlock(input)}`, { maxTokens: 6000 });
    const ok = accept(json);
    if (ok) {
      const bp = { ...ok.bp, checks: runDesignChecks(ok.bp) };
      return { blueprint: bp, checks: bp.checks, aiUsed: true, issues: ok.issues };
    }
  }
  const off = offlineBlueprint(input.idea);
  const bp = applyAnswers({ ...off.bp, checks: [] }, input);
  bp.checks = runDesignChecks(bp);
  return { blueprint: bp, checks: bp.checks, aiUsed: false, template: off.template, issues: off.issues };
}

/** Tiny deterministic use of guided answers / stack hint in offline mode. */
function applyAnswers(bp: Blueprint, input: GenerateInput): Blueprint {
  const text = Object.values(input.answers ?? {}).join(" ").toLowerCase();
  if (input.stackHint) bp.stack = { ...bp.stack, reasons: [...bp.stack.reasons, `User preference: ${input.stackHint.slice(0, 120)}`] };
  if (/\bno\b.*\bpayment|free|no billing/.test(text)) {
    bp.stack = { ...bp.stack, payments: undefined };
    bp.services = bp.services.filter((s) => s.name !== "stripe");
  }
  if (/postgres/.test(text + (input.stackHint ?? "").toLowerCase())) bp.stack = { ...bp.stack, database: "PostgreSQL via Prisma" };
  return bp;
}

export async function refineBlueprint(args: { blueprint: Blueprint; instruction: string }): Promise<{ blueprint: Blueprint; aiUsed: boolean; issues: Issue[] }> {
  const { blueprint, instruction } = args;
  if (await aiReady()) {
    const user = `Current blueprint JSON:\n${untrusted("blueprint", JSON.stringify(blueprint))}\n\nApply this change and return the FULL updated blueprint JSON (same schema, keep everything not affected):\n${untrusted("instruction", instruction)}`;
    const ok = accept(await chatJSON<unknown>(SYSTEM, user, { maxTokens: 6000 }));
    if (ok) {
      const bp = { ...ok.bp, checks: runDesignChecks(ok.bp) };
      return { blueprint: bp, aiUsed: true, issues: ok.issues };
    }
  }
  // Offline: record the instruction as an open assumption so it isn't lost.
  const id = `note_${blueprint.assumptions.length + 1}`;
  const bp: Blueprint = { ...blueprint, assumptions: [...blueprint.assumptions, { id, text: `Requested change (apply manually, AI offline): ${instruction.slice(0, 400)}`, alternative: "", chosen: false }] };
  bp.checks = runDesignChecks(bp);
  return { blueprint: bp, aiUsed: false, issues: [] };
}

export async function flipAssumption(blueprint: Blueprint, assumptionId: string): Promise<{ blueprint: Blueprint; aiUsed: boolean; issues: Issue[] }> {
  const a = blueprint.assumptions.find((x) => x.id === assumptionId);
  if (!a) throw new Error(`unknown assumption ${assumptionId}`);
  const flipped = blueprint.assumptions.map((x) => x.id === assumptionId ? { ...x, text: x.alternative || x.text, alternative: x.text, chosen: true } : x);
  if (a.alternative && (await aiReady())) {
    const r = await refineBlueprint({ blueprint: { ...blueprint, assumptions: flipped }, instruction: `Assumption "${a.text}" is now replaced by "${a.alternative}". Update entities, endpoints and pages accordingly.` });
    if (r.aiUsed) return r;
  }
  const bp = offlineFlip({ ...blueprint, assumptions: flipped }, a.text, a.alternative);
  bp.checks = runDesignChecks(bp);
  return { blueprint: bp, aiUsed: false, issues: [] };
}

/** Small deterministic structural changes for the common assumption flips. */
function offlineFlip(bp: Blueprint, was: string, now: string): Blueprint {
  const n = now.toLowerCase(), w = was.toLowerCase();
  const users = bp.entities.find((e) => e.table === "users");
  if (users && /single role|every member is equal/.test(n)) {
    users.columns = users.columns.filter((c) => c.name !== "role");
  } else if (users && /role|separate .* table/.test(n) && !users.columns.some((c) => c.name === "role")) {
    users.columns.push({ name: "role", type: "text", nullable: false, default: "'member'" });
  }
  if (/no billing|no online payment|no payment/.test(n)) {
    bp.stack = { ...bp.stack, payments: undefined };
    bp.services = bp.services.filter((s) => s.name !== "stripe");
  } else if (/stripe/.test(n) && !/stripe/.test(w) && !bp.services.some((s) => s.name === "stripe")) {
    bp.services = [...bp.services, { name: "stripe", purpose: "Payments" }];
    bp.stack = { ...bp.stack, payments: "Stripe Checkout" };
  }
  if (/variants table/.test(n) && !bp.entities.some((e) => e.table === "variants")) {
    const prod = bp.entities.find((e) => e.table === "products") ?? bp.entities[1];
    bp.entities.push({ name: "Variant", table: "variants", description: "Size/colour variant of a product.", columns: [
      { name: "id", type: "uuid", nullable: false, pk: true, default: "gen_random_uuid()" },
      { name: `${prod.table.replace(/s$/, "")}_id`, type: "uuid", nullable: false, references: { table: prod.table, column: "id" } },
      { name: "sku", type: "text", nullable: false, unique: true }, { name: "label", type: "text", nullable: false }, { name: "stock", type: "integer", nullable: false, default: "0" },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ], indexes: [{ columns: [`${prod.table.replace(/s$/, "")}_id`] }] });
  }
  if (/stages table/.test(n) && !bp.entities.some((e) => e.table === "stages")) {
    bp.entities.push({ name: "Stage", table: "stages", description: "Editable pipeline stage.", columns: [
      { name: "id", type: "uuid", nullable: false, pk: true, default: "gen_random_uuid()" }, { name: "name", type: "text", nullable: false, unique: true }, { name: "position", type: "integer", nullable: false },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ] });
  }
  return bp;
}

// ---------------- design checks ----------------

const PII = /^(email|phone|password|password_hash|ssn|date_of_birth|dob|address|card_number)$/;

export function runDesignChecks(bp: Blueprint): Check[] {
  const checks: Check[] = [];
  const tables = new Map(bp.entities.map((e) => [e.table, e]));
  const eps = new Map(bp.endpoints.map((e) => [endpointRef(e), e]));

  const missingIx: string[] = [];
  for (const e of bp.entities) for (const c of e.columns)
    if (c.references && !(e.indexes ?? []).some((ix) => ix.columns[0] === c.name) && !c.pk && !c.unique) missingIx.push(`${e.table}.${c.name}`);
  checks.push({ name: "FK columns indexed", ok: missingIx.length === 0, detail: missingIx.length ? `Add indexes on: ${missingIx.join(", ")}` : "Every foreign key has an index" });

  const openWrites = bp.endpoints.filter((e) => !e.auth && e.writes.length && !e.internal && !/webhook|signup|login|register/.test(e.path));
  checks.push({ name: "Writes require auth", ok: openWrites.length === 0, detail: openWrites.length ? `Unauthenticated writes: ${openWrites.map(endpointRef).join(", ")}` : "All writing endpoints require auth (except signup/login/webhooks)" });

  const pii = bp.entities.flatMap((e) => e.columns.filter((c) => PII.test(c.name)).map((c) => `${e.table}.${c.name}`));
  checks.push({ name: "PII columns identified", ok: true, detail: pii.length ? `Handle with care (hash/encrypt, never log): ${pii.join(", ")}` : "No PII columns detected" });
  const plainPw = bp.entities.flatMap((e) => e.columns.filter((c) => c.name === "password").map((c) => `${e.table}.${c.name}`));
  if (plainPw.length) checks.push({ name: "Passwords hashed", ok: false, detail: `Rename to password_hash and store a bcrypt/argon2 hash: ${plainPw.join(", ")}` });

  const unbound: string[] = [];
  for (const p of bp.pages) for (const f of p.fields) {
    const ep = f.endpoint ? eps.get(f.endpoint) : undefined;
    const keyOk = ep ? ep.request.some((r) => r.key === f.key || r.fromField === f.key) : false;
    const cr = f.column ? parseColumnRef(f.column) : null;
    const colOk = !!cr && !!tables.get(cr.table)?.columns.some((c) => c.name === cr.column);
    if (!(keyOk && colOk)) unbound.push(`${p.path}#${f.key}${keyOk ? "" : " (no request key)"}${colOk ? "" : " (no column)"}`);
  }
  checks.push({ name: "Form fields bound end-to-end", ok: unbound.length === 0, detail: unbound.length ? `Unbound: ${unbound.join(", ")}` : "Every field maps to a request key and a column" });

  const called = new Set(bp.pages.flatMap((p) => [...p.calls, ...p.fields.map((f) => f.endpoint).filter((x): x is string => !!x)]));
  const orphan = bp.endpoints.filter((e) => !e.internal && !called.has(endpointRef(e))).map(endpointRef);
  checks.push({ name: "Endpoints reachable from a page", ok: orphan.length === 0, detail: orphan.length ? `Not called by any page (mark internal if intended): ${orphan.join(", ")}` : "Every public endpoint is called by a page" });

  const noTables = bp.endpoints.filter((e) => !e.reads.length && !e.writes.length).map(endpointRef);
  checks.push({ name: "Endpoints touch data", ok: noTables.length === 0, detail: noTables.length ? `No reads/writes declared: ${noTables.join(", ")}` : "Every endpoint declares its tables" });

  const noCreated = bp.entities.filter((e) => !e.columns.some((c) => c.name === "created_at")).map((e) => e.table);
  checks.push({ name: "Tables have created_at", ok: noCreated.length === 0, detail: noCreated.length ? `Missing created_at: ${noCreated.join(", ")}` : "All tables carry created_at" });
  return checks;
}

// ---------------- guided questions ----------------

export const CANNED_QUESTIONS = [
  { id: "users", q: "Who uses it? List the user types / roles (e.g. admin, customer, vendor)." },
  { id: "workflow", q: "What is the one key workflow a user completes end to end?" },
  { id: "payments", q: "Does it take payments? One-off, subscriptions, or none?" },
  { id: "integrations", q: "Which external services must it talk to (email, SMS, calendar, Stripe, S3…)?" },
  { id: "scale", q: "Expected scale in year one: users, records, traffic?" },
];

export async function guidedQuestions(idea: string): Promise<{ questions: { id: string; q: string }[]; aiUsed: boolean }> {
  if (await aiReady()) {
    const json = await chatJSON<{ questions?: unknown }>(
      `You help an architect clarify a product idea before designing it. Return {"questions":[{"id":"snake_id","q":"question"}]} with 3-5 short, specific questions covering: user roles, key workflow, payments, integrations, scale. No generic questions.`,
      untrusted("idea", idea), { fast: true, maxTokens: 800 });
    const qs = Array.isArray(json?.questions) ? (json!.questions as unknown[]).filter((x): x is { id: string; q: string } => !!x && typeof x === "object" && typeof (x as { q?: unknown }).q === "string")
      .map((x, i) => ({ id: typeof x.id === "string" ? x.id.replace(/[^a-z0-9_]/gi, "_").slice(0, 40) : `q${i + 1}`, q: x.q.slice(0, 300) })).slice(0, 5) : [];
    if (qs.length >= 3) return { questions: qs, aiUsed: true };
  }
  return { questions: CANNED_QUESTIONS, aiUsed: false };
}
