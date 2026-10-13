// Code generators used by scaffoldProject: one route.ts per endpoint path, one page.tsx per page.
import type { Blueprint, Endpoint, Entity, Page } from "./schema";
import { endpointRef } from "./schema";
import { camel, modelName } from "./export";

const q = JSON.stringify;
const isIdent = (k: string) => /^[a-zA-Z_$][\w$]*$/.test(k);
const prop = (k: string) => isIdent(k) ? `body.${k}` : `body[${q(k)}]`;
const objKey = (k: string) => isIdent(k) ? k : q(k);

/** Prisma `data: {…}` entries for request keys that are non-pk columns of the table (with type coercion). */
function dataEntries(ep: Endpoint, table: Entity, db: string): string[] {
  const out: string[] = [];
  for (const r of ep.request) {
    const col = table.columns.find((c) => c.name === r.key);
    if (!col || col.pk) continue;
    let v = prop(r.key);
    if (col.type === "timestamptz" || col.type === "date") v = r.required ? `new Date(${v})` : `${v} ? new Date(${v}) : undefined`;
    else if (col.type === "jsonb" && db === "sqlite") v = `typeof ${v} === "string" ? ${v} : JSON.stringify(${v})`;
    else if (col.type === "numeric" || col.type === "integer") v = /number/i.test(r.type) ? v : `Number(${v})`;
    out.push(`${camel(col.name)}: ${v}`);
  }
  return out;
}
export const clientProp = (e: Entity) => { const m = modelName(e); return m.charAt(0).toLowerCase() + m.slice(1); };
const pathParams = (p: string) => [...p.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);

function zodFor(r: Endpoint["request"][number]): string {
  let z = /number|int|numeric|float/i.test(r.type) ? "z.coerce.number()" : /bool/i.test(r.type) ? "z.coerce.boolean()" : /array/i.test(r.type) ? "z.array(z.unknown())" : /object|json/i.test(r.type) ? "z.record(z.string(), z.unknown())" : "z.string()";
  const v = r.validation ?? "";
  if (z === "z.string()") {
    if (/email/i.test(v) || r.key === "email") z += ".email()";
    const min = v.match(/min\((\d+)\)/); if (min) z += `.min(${min[1]})`;
    const max = v.match(/max\((\d+)\)/); if (max) z += `.max(${max[1]})`;
    if (/uuid/i.test(v) || /_id$/.test(r.key)) z += ".min(1)";
    if (/slug/i.test(v)) z += ".regex(/^[a-z0-9-]+$/)";
  } else if (z === "z.coerce.number()") {
    const range = v.match(/(\d+)\.\.(\d+)/); if (range) z += `.min(${range[1]}).max(${range[2]})`;
    const min = v.match(/min\((\d+)\)/); if (min) z += `.min(${min[1]})`;
  }
  return r.required ? z : `${z}.optional()`;
}

function handler(ep: Endpoint, bp: Blueprint, db: string): string {
  const params = pathParams(ep.path);
  const byTable = new Map(bp.entities.map((e) => [e.table, e]));
  const writeT = ep.writes.map((t) => byTable.get(t)).find(Boolean);
  const readT = ep.reads.map((t) => byTable.get(t)).find(Boolean);
  const L: string[] = [];
  const schemaName = `${ep.method}Body`;
  const hasBody = ep.request.length > 0 && ep.method !== "GET" && ep.method !== "DELETE";
  if (hasBody) L.push(`const ${schemaName} = z.object({\n${ep.request.map((r) => `  ${objKey(r.key)}: ${zodFor(r)},`).join("\n")}\n});`, "");
  L.push(`/** ${ep.name} — ${ep.description || endpointRef(ep)}${ep.reads.length ? ` · reads ${ep.reads.join(", ")}` : ""}${ep.writes.length ? ` · writes ${ep.writes.join(", ")}` : ""} */`);
  L.push(`export async function ${ep.method}(req: Request${params.length ? `, { params }: { params: Promise<{ ${params.map((p) => `${p}: string`).join("; ")} }> }` : ""}) {`);
  if (params.length) L.push(`  const { ${params.join(", ")} } = await params;`);
  if (ep.auth) L.push(`  const session = await requireSession(req);`, `  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });`);
  if (hasBody) L.push(`  const parsed = ${schemaName}.safeParse(await req.json().catch(() => ({})));`, `  if (!parsed.success) return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });`, `  const body = parsed.data;`);
  else if (ep.method === "GET" && ep.request.length) L.push(`  const url = new URL(req.url);`, ...ep.request.map((r) => `  const ${camel(r.key)} = url.searchParams.get(${q(r.key)});`));

  const isSignup = /signup|register/.test(ep.path), isLogin = /login|signin/.test(ep.path);
  const users = byTable.get("users");
  if (isSignup && users && hasBody) {
    const pw = users.columns.find((c) => /password/.test(c.name));
    L.push(`  const exists = await prisma.${clientProp(users)}.findUnique({ where: { email: body.email } });`, `  if (exists) return NextResponse.json({ error: "email_taken" }, { status: 409 });`,
      `  const user = await prisma.${clientProp(users)}.create({ data: { ${dataEntries({ ...ep, request: ep.request.filter((r) => r.key !== "password") }, users, db).join(", ")}${pw ? `, ${camel(pw.name)}: hashPassword(String(body.password ?? ""))` : ""} } });`,
      `  const res = NextResponse.json({ id: user.id, email: user.email }, { status: 201 });`, `  setSessionCookie(res, user.id);`, `  return res;`);
  } else if (isLogin && users && hasBody) {
    const pw = users.columns.find((c) => /password/.test(c.name));
    L.push(`  const user = await prisma.${clientProp(users)}.findUnique({ where: { email: body.email } });`,
      `  if (!user${pw ? ` || !verifyPassword(String(body.password ?? ""), user.${camel(pw.name)})` : ""}) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });`,
      `  const res = NextResponse.json({ token: "cookie", id: user.id });`, `  setSessionCookie(res, user.id);`, `  return res;`);
  } else if (ep.method === "GET" && readT && params.includes("id")) {
    L.push(`  const row = await prisma.${clientProp(readT)}.findUnique({ where: { id } });`, `  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });`, `  return NextResponse.json(row);`);
  } else if (ep.method === "GET" && readT) {
    const hasPage = ep.request.some((r) => r.key === "page");
    L.push(`  const take = 50;${hasPage ? ` const skip = (Math.max(1, Number(page) || 1) - 1) * take;` : ""}`, `  const items = await prisma.${clientProp(readT)}.findMany({ take,${hasPage ? " skip," : ""} orderBy: { createdAt: "desc" } });`, `  return NextResponse.json({ items });`);
  } else if (ep.method === "POST" && writeT && hasBody && !params.length && !ep.internal && !/webhook/.test(ep.path) && dataEntries(ep, writeT, db).length) {
    const data = dataEntries(ep, writeT, db);
    const fromSession = writeT.columns.filter((c) => c.references?.table === "users" && !c.nullable && !ep.request.some((r) => r.key === c.name));
    if (ep.auth) for (const c of fromSession) data.push(`${camel(c.name)}: session.userId`);
    L.push(`  const row = await prisma.${clientProp(writeT)}.create({ data: { ${data.join(", ")} } });`, `  return NextResponse.json({ id: row.id }, { status: 201 });`);
  } else if ((ep.method === "PATCH" || ep.method === "PUT") && writeT && params.includes("id")) {
    L.push(`  const row = await prisma.${clientProp(writeT)}.update({ where: { id }, data: { ${hasBody ? dataEntries(ep, writeT, db).join(", ") : ""} } }).catch(() => null);`, `  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });`, `  return NextResponse.json({ id: row.id });`);
  } else if (ep.method === "DELETE" && writeT && params.includes("id")) {
    L.push(`  const row = await prisma.${clientProp(writeT)}.delete({ where: { id } }).catch(() => null);`, `  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });`, `  return NextResponse.json({ ok: true });`);
  } else {
    L.push(`  // TODO(arkus): implement ${endpointRef(ep)}${ep.reads.length ? ` · reads ${ep.reads.join(", ")}` : ""}${ep.writes.length ? ` · writes ${ep.writes.join(", ")}` : ""}`, `  void prisma;${hasBody ? " void body;" : ""}${params.length ? ` void ${params.join("; void ")};` : ""}`, `  return NextResponse.json({ error: "not_implemented", endpoint: ${q(endpointRef(ep))} }, { status: 501 });`);
  }
  L.push("}");
  return L.join("\n");
}

export function routeFile(eps: Endpoint[], bp: Blueprint, db = "sqlite"): string {
  const needsAuth = eps.some((e) => e.auth), needsSignup = eps.some((e) => /signup|register/.test(e.path)), needsLogin = eps.some((e) => /login|signin/.test(e.path));
  const authImports = [needsAuth ? "requireSession" : "", needsSignup || needsLogin ? "setSessionCookie" : "", needsSignup ? "hashPassword" : "", needsLogin ? "verifyPassword" : ""].filter(Boolean);
  const imports = [`import { NextResponse } from "next/server";`, `import { z } from "zod";`, `import { prisma } from "@/lib/db";`];
  if (authImports.length) imports.push(`import { ${authImports.join(", ")} } from "@/lib/auth";`);
  return [`// Generated by Arkus Architect · ${eps.map(endpointRef).join(" · ")}`, ...imports, "", eps.map((e) => handler(e, bp, db)).join("\n\n"), ""].join("\n");
}

// ---------------- pages ----------------

function input(f: Page["fields"][number]): string {
  const base = `name=${q(f.key)}${f.required ? " required" : ""} className="input"`;
  if (f.uiType === "textarea") return `<textarea ${base} rows={4} />`;
  if (f.uiType === "select") return `<input type="text" ${base} placeholder=${q(`${f.label} id`)} />`;
  if (f.uiType === "checkbox") return `<input type="checkbox" name=${q(f.key)} />`;
  if (f.uiType === "hidden") return `<input type="hidden" name=${q(f.key)} value={String(params.id ?? "")} />`;
  const t = ["email", "password", "number", "date"].includes(f.uiType) ? f.uiType : "text";
  return `<input type=${q(t)} ${base} />`;
}

export function pageFile(p: Page, bp: Blueprint): string {
  const primary = p.fields[0]?.endpoint ?? p.calls.find((c) => /^(POST|PUT|PATCH|DELETE)/.test(c)) ?? p.calls[0];
  const get = p.calls.find((c) => c.startsWith("GET "));
  const ep = primary ? bp.endpoints.find((e) => endpointRef(e) === primary) : undefined;
  const urlExpr = (ref: string) => "`" + ref.split(" ")[1].replace(/:([a-zA-Z0-9_]+)/g, "${params.$1}") + "`";
  const usesParams = /:/.test(p.path) || p.fields.some((f) => f.uiType === "hidden") || [primary, get].some((r) => r && /:/.test(r));
  const isForm = !!ep && (p.kind === "form" || p.kind === "auth");
  const isFetch = !!get && (p.kind === "list" || p.kind === "display");
  const L: string[] = [`"use client";`, `// Generated by Arkus Architect · page ${p.path} (${p.kind})${p.calls.length ? ` · calls ${p.calls.join(", ")}` : ""}`,
    `import { ${[isFetch ? "useEffect" : "", "useState", isForm ? "type FormEvent" : ""].filter(Boolean).join(", ")} } from "react";`];
  if (usesParams) L.push(`import { useParams } from "next/navigation";`);
  L.push("", `export default function ${pascalPage(p)}Page() {`);
  if (usesParams) L.push(`  const params = useParams<Record<string, string>>();`);
  L.push(`  const [result, setResult] = useState<unknown>(null);`);
  if (isFetch) {
    L.push(`  // eslint-disable-next-line react-hooks/exhaustive-deps`, `  useEffect(() => { fetch(${urlExpr(get!)}).then((r) => r.json()).then(setResult).catch((e) => setResult({ error: String(e) })); }, []);`);
  }
  if (isForm) {
    L.push(`  async function onSubmit(e: FormEvent<HTMLFormElement>) {`, `    e.preventDefault();`, `    const fd = new FormData(e.currentTarget);`,
      `    const body: Record<string, unknown> = {};`, `    fd.forEach((v, k) => { body[k] = v; });`,
      `    const res = await fetch(${urlExpr(primary!)}, { method: ${q(ep.method)}, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });`,
      `    setResult(await res.json().catch(() => ({ status: res.status })));`, `  }`);
  }
  L.push(`  return (`, `    <main className="page">`, `      <h1>${esc(p.name)}</h1>`);
  if (isForm) {
    L.push(`      <form onSubmit={onSubmit} className="form">`);
    for (const f of p.fields) L.push(`        <label>${f.uiType === "hidden" ? "" : `<span>${esc(f.label)}</span>`}${input(f)}</label>`);
    L.push(`        <button type="submit">${esc(ep!.name)}</button>`, `      </form>`);
  }
  if (p.kind === "list") L.push(`      <table className="table"><tbody>{(((result as { items?: Record<string, unknown>[] })?.items) ?? []).map((row, i) => (<tr key={String(row.id ?? i)}>{Object.entries(row).map(([k, v]) => <td key={k}>{String(v ?? "")}</td>)}</tr>))}</tbody></table>`);
  L.push(`      <pre className="result">{result ? JSON.stringify(result, null, 2) : ${q(p.kind === "list" ? "Loading…" : p.kind === "display" ? "Loading…" : "")}}</pre>`, `    </main>`, `  );`, `}`, "");
  return L.join("\n");
}

const esc = (s: string) => s.replace(/[{}<>]/g, "");
const pascalPage = (p: Page) => (p.path === "/" ? "Home" : p.path.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("")) || "Page";
