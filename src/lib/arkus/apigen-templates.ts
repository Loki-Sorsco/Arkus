// Deterministic route templates for apigen.ts. One TypeScript generator covers Next App Router, Next pages
// and Express through a small adapter (how to read the query, params and body, how to answer); data
// access is Prisma or a raw-SQL helper (db.query) depending on what the project already uses. FastAPI
// gets a Python router. The output is plain code the author can read and edit; no runtime magic.
import type { ApiSpec } from "./apigen";

export type FieldKind = "number" | "boolean" | "string" | "date";
export type Model = {
  name: string; client: string; table: string;
  fields: { name: string; kind: FieldKind; required: boolean }[];
  filters: { name: string; kind: FieldKind }[];
  pk: string; pkNumeric: boolean; param: string | null;
  orderBy?: { column: string; dir: "asc" | "desc" }; limit: number;
};
export type Adapter = { flavor: "next-app" | "next-pages" | "express"; q: (n: string) => string; param: (n: string) => string; body: string; json: (expr: string, status?: number) => string; nextResponse?: boolean };
export type Db = { kind: "prisma" | "sql" | "none"; importLine: string; client: string; ph: (i: number) => string };
export type Auth = { importLine: string; call: string; name: string } | { wrapper: string } | null;

const LABEL: Record<ApiSpec["purpose"], string> = { list: "list rows", get_one: "fetch one row", create: "create a row", update: "update a row", delete: "delete a row", custom: "custom handler" };
const cast = (kind: FieldKind, expr: string) => kind === "number" ? `Number(${expr})` : kind === "boolean" ? `Boolean(${expr})` : kind === "date" ? `new Date(String(${expr}))` : `String(${expr})`;
const writable = (m: Model) => m.fields.filter((f) => f.name !== m.pk && !/^(created|updated)_?at$/i.test(f.name));
/** `, select: { … }` for the fields, or nothing when the form picked none (Prisma rejects an empty select). */
const sel = (m: Model) => (m.fields.length ? `, select: { ${m.fields.map((f) => `${f.name}: true`).join(", ")} }` : "");
const cols = (m: Model) => m.fields.map((f) => f.name).join(", ") || "*";

/** The handler body (statements, unindented) for one purpose. */
function body(spec: ApiSpec, m: Model, a: Adapter, db: Db, auth: Auth): string[] {
  const out: string[] = [];
  const json = a.json;
  if (spec.auth) {
    if (auth && "call" in auth) out.push("// Auth: the same helper the other handlers use", `const session = await ${auth.call};`, `if (!session) return ${json('{ error: "Unauthorized" }', 401)};`);
    else out.push("// TODO: add your auth check here (answer 401 when the caller is not signed in)", `// if (!signedIn) return ${json('{ error: "Unauthorized" }', 401)};`);
    out.push("");
  }
  const idVar = m.param || "id";
  const idRead = m.param ? a.param(m.param) : `const ${idVar} = ${a.q("id")} ?? "";`;
  const idVal = m.pkNumeric ? `Number(${idVar})` : idVar;
  const noDb = db.kind === "none";
  if (spec.purpose === "list") {
    if (a.flavor === "next-app") out.push("const url = new URL(req.url);");
    for (const f of m.filters) out.push(`const ${f.name} = ${a.q(f.name)};`);
    out.push(`const take = Math.min(Number(${a.q("limit")} || ${m.limit}), 200);`, "");
    if (db.kind === "prisma") {
      const where = m.filters.map((f) => `    ...(${f.name} ? { ${f.name}: ${f.kind === "string" ? `{ contains: ${f.name} }` : cast(f.kind, f.name)} } : {}),`);
      out.push(`const rows = await ${db.client}.${m.client}.findMany({`, ...(where.length ? ["  where: {", ...where, "  },"] : []), ...(m.fields.length ? [`  ${sel(m).slice(2)},`] : []), ...(m.orderBy ? [`  orderBy: { ${m.orderBy.column}: "${m.orderBy.dir}" },`] : []), "  take,", "});");
    } else if (db.kind === "sql") {
      out.push("const where: string[] = [];", "const args: unknown[] = [];");
      for (const f of m.filters) out.push(`if (${f.name}) { args.push(${f.kind === "string" ? `\`%\${${f.name}}%\`` : cast(f.kind, f.name)}); where.push(\`${f.name} ${f.kind === "string" ? "LIKE" : "="} ${db.ph(0).replace("0", "${args.length}")}\`); }`);
      out.push("args.push(take);", `const { rows } = await ${db.client}.query(\`SELECT ${cols(m)} FROM ${m.table}\${where.length ? \` WHERE \${where.join(" AND ")}\` : ""}${m.orderBy ? ` ORDER BY ${m.orderBy.column} ${m.orderBy.dir.toUpperCase()}` : ""} LIMIT ${db.ph(0).replace("0", "${args.length}")}\`, args);`);
    } else out.push(`// TODO: load up to \`take\` rows from ${m.table} (fields: ${cols(m)})${m.filters.length ? ` filtered by ${m.filters.map((f) => f.name).join(", ")}` : ""}`, "const rows: unknown[] = [];");
    out.push(`return ${json(`{ ${m.client}s: rows }`)};`);
  } else if (spec.purpose === "get_one") {
    out.push(idRead);
    if (db.kind === "prisma") out.push(`const row = await ${db.client}.${m.client}.findUnique({ where: { ${m.pk}: ${idVal} }${sel(m)} });`);
    else if (db.kind === "sql") out.push(`const { rows } = await ${db.client}.query(\`SELECT ${cols(m)} FROM ${m.table} WHERE ${m.pk} = ${db.ph(1)} LIMIT 1\`, [${idVal}]);`, "const row = rows[0] ?? null;");
    else out.push(`// TODO: load the ${m.table} row where ${m.pk} = ${idVal}`, "const row: unknown = null;");
    out.push(`if (!row) return ${json('{ error: "Not found" }', 404)};`, `return ${json(`{ ${m.client}: row }`)};`);
  } else if (spec.purpose === "create") {
    const w = writable(m);
    out.push(`const body = (${a.body}) as Record<string, unknown>;`);
    const req = w.filter((f) => f.required).map((f) => `"${f.name}"`);
    if (req.length) out.push(`for (const k of [${req.join(", ")}]) if (body[k] == null || body[k] === "") return ${json("{ error: `${k} is required` }", 400)};`);
    const data = w.map((f) => (f.required ? `${f.name}: ${cast(f.kind, `body.${f.name}`)}` : `...(body.${f.name} != null ? { ${f.name}: ${cast(f.kind, `body.${f.name}`)} } : {})`));
    out.push(...(data.length ? ["const data = {", ...data.map((d) => `  ${d},`), "};"] : ["const data = {};"]));
    if (db.kind === "prisma") out.push(`const created = await ${db.client}.${m.client}.create({ data${sel(m)} });`);
    else if (db.kind === "sql") out.push("const keys = Object.keys(data);", `const { rows } = await ${db.client}.query(\`INSERT INTO ${m.table} (\${keys.join(", ")}) VALUES (\${keys.map((_, i) => \`${db.ph(0).replace("0", "${i + 1}")}\`).join(", ")}) RETURNING ${cols(m)}\`, Object.values(data));`, "const created = rows[0];");
    else out.push(`// TODO: insert \`data\` into ${m.table} and return the new row`, "const created = data;");
    out.push(`return ${json(`{ ${m.client}: created }`, 201)};`);
  } else if (spec.purpose === "update") {
    const w = writable(m);
    out.push(idRead, `const body = (${a.body}) as Record<string, unknown>;`, "const data = {", ...w.map((f) => `  ...(body.${f.name} != null ? { ${f.name}: ${cast(f.kind, `body.${f.name}`)} } : {}),`), "};", `if (!Object.keys(data).length) return ${json('{ error: "Nothing to update" }', 400)};`);
    if (db.kind === "prisma") out.push(`const updated = await ${db.client}.${m.client}.update({ where: { ${m.pk}: ${idVal} }, data${sel(m)} }).catch(() => null);`);
    else if (db.kind === "sql") out.push("const keys = Object.keys(data);", `const { rows } = await ${db.client}.query(\`UPDATE ${m.table} SET \${keys.map((k, i) => \`\${k} = ${db.ph(0).replace("0", "${i + 1}")}\`).join(", ")} WHERE ${m.pk} = ${db.ph(0).replace("0", "${keys.length + 1}")} RETURNING ${cols(m)}\`, [...Object.values(data), ${idVal}]);`, "const updated = rows[0] ?? null;");
    else out.push(`// TODO: update the ${m.table} row where ${m.pk} = ${idVal} with \`data\``, "const updated: unknown = null;");
    out.push(`if (!updated) return ${json('{ error: "Not found" }', 404)};`, `return ${json(`{ ${m.client}: updated }`)};`);
  } else if (spec.purpose === "delete") {
    out.push(idRead);
    if (db.kind === "prisma") out.push(`const deleted = await ${db.client}.${m.client}.delete({ where: { ${m.pk}: ${idVal} } }).catch(() => null);`, `if (!deleted) return ${json('{ error: "Not found" }', 404)};`);
    else if (db.kind === "sql") out.push(`const { rowCount } = await ${db.client}.query(\`DELETE FROM ${m.table} WHERE ${m.pk} = ${db.ph(1)}\`, [${idVal}]);`, `if (!rowCount) return ${json('{ error: "Not found" }', 404)};`);
    else out.push(`// TODO: delete the ${m.table} row where ${m.pk} = ${idVal}`);
    out.push(`return ${json("{ ok: true }")};`);
  } else {
    out.push(`// TODO: ${spec.description || "implement this handler"}`, ...(noDb ? [] : [`// ${db.client} is imported above for database access.`]), `return ${json("{ ok: true }")};`);
  }
  return out;
}

/** Whole TypeScript file: header comment, imports, handler. */
export function renderTs(spec: ApiSpec, m: Model, a: Adapter, db: Db, auth: Auth): string {
  const head = [`// ${spec.method} ${spec.path} - ${spec.description || LABEL[spec.purpose]}${spec.table ? ` (${m.table})` : ""}`, "// Generated by Arkus; edit freely."];
  const imports: string[] = [];
  if (a.flavor === "next-app" && a.nextResponse) imports.push('import { NextResponse } from "next/server";');
  if (a.flavor === "next-pages") imports.push('import type { NextApiRequest, NextApiResponse } from "next";');
  if (a.flavor === "express") imports.push('import { Router } from "express";');
  if (db.importLine && spec.purpose !== "custom") imports.push(db.importLine);
  if (spec.auth && auth && "importLine" in auth) imports.push(auth.importLine);
  const lines = body(spec, m, a, db, auth).map((l) => (l ? "  " + l : l));
  const method = spec.method;
  let handler: string[];
  const reqName = lines.some((l) => /\breq\b/.test(l)) ? "req" : "_req";
  if (a.flavor === "next-app") handler = [`export async function ${method}(${reqName}: Request${m.param ? `, ctx: { params: Promise<{ ${m.param}: string }> }` : ""}) {`, ...lines, "}"];
  else if (a.flavor === "next-pages") handler = ["export default async function handler(req: NextApiRequest, res: NextApiResponse) {", `  if (req.method !== "${method}") return res.status(405).json({ error: "Method not allowed" });`, ...lines, "}"];
  else handler = ["const router = Router();", "", `router.${method.toLowerCase()}("${spec.path}", async (req, res) => {`, ...lines, "});", "", "export default router;"];
  return [...head, "", ...imports, ...(imports.length ? [""] : []), ...handler, ""].join("\n");
}

const PY_KIND: Record<FieldKind, string> = { number: "float", boolean: "bool", string: "str", date: "str" };
/** FastAPI router with the same shape; data access is left as a TODO since the client is project-specific. */
export function renderPython(spec: ApiSpec, m: Model, auth: { call: string } | null): string {
  const path = spec.path.replace(/:(\w+)/g, "{$1}");
  const fn = `${spec.purpose === "list" ? "list" : spec.purpose === "get_one" ? "get" : spec.purpose === "custom" ? "handle" : spec.purpose}_${m.client.toLowerCase()}`;
  const args: string[] = [];
  if (m.param) args.push(`${m.param}: ${m.pkNumeric ? "int" : "str"}`);
  if (spec.purpose === "list") args.push(...m.filters.map((f) => `${f.name}: Optional[${PY_KIND[f.kind]}] = None`), `limit: int = ${m.limit}`);
  if (spec.purpose === "create" || spec.purpose === "update") args.push("body: dict");
  const b: string[] = [];
  if (spec.auth) b.push(auth ? `user = ${auth.call}  # same helper the other routes use` : "# TODO: add your auth check here (raise HTTPException(401) when not signed in)");
  if (spec.purpose === "list") b.push(`# TODO: select ${cols(m)} from ${m.table}${m.filters.length ? ` filtered by ${m.filters.map((f) => f.name).join(", ")}` : ""}, at most \`limit\` rows`, "rows: list[dict] = []", `return {"${m.client}s": rows}`);
  else if (spec.purpose === "get_one") b.push(`# TODO: load the ${m.table} row where ${m.pk} == ${m.param || "id"}`, "row = None", 'if row is None:', '    raise HTTPException(status_code=404, detail="Not found")', `return {"${m.client}": row}`);
  else if (spec.purpose === "create") b.push(`for k in [${writable(m).filter((f) => f.required).map((f) => `"${f.name}"`).join(", ")}]:`, "    if body.get(k) in (None, \"\"):", '        raise HTTPException(status_code=400, detail=f"{k} is required")', `# TODO: insert into ${m.table}: ${writable(m).map((f) => f.name).join(", ")}`, `return {"${m.client}": body}`);
  else if (spec.purpose === "update") b.push(`data = {k: body[k] for k in [${writable(m).map((f) => `"${f.name}"`).join(", ")}] if k in body}`, "if not data:", '    raise HTTPException(status_code=400, detail="Nothing to update")', `# TODO: update the ${m.table} row where ${m.pk} == ${m.param || "id"}`, `return {"${m.client}": data}`);
  else if (spec.purpose === "delete") b.push(`# TODO: delete the ${m.table} row where ${m.pk} == ${m.param || "id"}`, 'return {"ok": True}');
  else b.push(`# TODO: ${spec.description || "implement this handler"}`, 'return {"ok": True}');
  return [`# ${spec.method} ${spec.path} - ${spec.description || LABEL[spec.purpose]}`, "# Generated by Arkus; edit freely.", "from typing import Optional", "from fastapi import APIRouter, HTTPException", "", "router = APIRouter()", "", "", `@router.${spec.method.toLowerCase()}("${path}")`, `async def ${fn}(${args.join(", ")}):`, ...b.map((l) => "    " + l), ""].join("\n");
}
