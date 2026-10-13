// ORM / SQL usage inside backend files → OrmUsageFact(file, table, op, via, line).
// Prisma emits the model name as written (`prisma.user` → "user"); the resolver maps model → table.
import ts from "typescript";
import type { ExtractContext, Extractor, OrmUsageFact, Facts } from "../types";
import { parseTs, lineOf, lineOfOffset, walk, dotted, isCodeFile, isTestFile, isSkipped, MAX_FILE_BYTES, safeRead } from "./util";

type Op = "read" | "write";
const PRISMA_OPS: Record<string, Op> = { findMany: "read", findUnique: "read", findFirst: "read", findUniqueOrThrow: "read", findFirstOrThrow: "read", count: "read", aggregate: "read", groupBy: "read", create: "write", update: "write", delete: "write", upsert: "write", createMany: "write", updateMany: "write", deleteMany: "write", createManyAndReturn: "write" };
const MONGOOSE_OPS: Record<string, Op> = { find: "read", findOne: "read", findById: "read", countDocuments: "read", estimatedDocumentCount: "read", aggregate: "read", exists: "read", distinct: "read", findAll: "read", findByPk: "read", findAndCountAll: "read", findOrCreate: "write", create: "write", insertMany: "write", updateOne: "write", updateMany: "write", findByIdAndUpdate: "write", findOneAndUpdate: "write", findByIdAndDelete: "write", findOneAndDelete: "write", deleteOne: "write", deleteMany: "write", bulkCreate: "write", update: "write", destroy: "write", upsert: "write", bulkWrite: "write", replaceOne: "write" };
const TYPEORM_OPS: Record<string, Op> = { find: "read", findOne: "read", findOneBy: "read", findBy: "read", findAndCount: "read", count: "read", countBy: "read", exist: "read", existsBy: "read", findOneOrFail: "read", createQueryBuilder: "read", query: "read", save: "write", insert: "write", update: "write", upsert: "write", delete: "write", remove: "write", softDelete: "write", restore: "write", increment: "write", decrement: "write" };

function sqlUsage(sql: string): { table: string; op: Op }[] {
  const out: { table: string; op: Op }[] = [];
  const t = (s: string) => s.replace(/["`\[\]]/g, "").split(".").pop()!.toLowerCase();
  if (!/\b(select|insert|update|delete|from|join)\b/i.test(sql)) return out;
  for (const m of sql.matchAll(/\bFROM\s+((?:["`\[]?[\w]+["`\]]?\.)?["`\[]?\w+["`\]]?)/gi)) if (!/^(select|\()/i.test(m[1])) out.push({ table: t(m[1]), op: /\bDELETE\s+FROM\s+/i.test(sql) && new RegExp(`DELETE\\s+FROM\\s+${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(sql) ? "write" : "read" });
  for (const m of sql.matchAll(/\bJOIN\s+((?:["`\[]?\w+["`\]]?\.)?["`\[]?\w+["`\]]?)/gi)) out.push({ table: t(m[1]), op: "read" });
  for (const m of sql.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+((?:["`\[]?\w+["`\]]?\.)?["`\[]?\w+["`\]]?)/gi)) out.push({ table: t(m[1]), op: "write" });
  for (const m of sql.matchAll(/\bUPDATE\s+((?:["`\[]?\w+["`\]]?\.)?["`\[]?\w+["`\]]?)\s+SET\b/gi)) out.push({ table: t(m[1]), op: "write" });
  return out.filter((x) => x.table && !/^(select|where|values|set|\d+)$/.test(x.table));
}

function scanJs(rel: string, text: string, out: OrmUsageFact[]) {
  const sf = parseTs(rel, text);
  const push = (table: string, op: Op, via: OrmUsageFact["via"], node: ts.Node) => { if (table) out.push({ file: rel, table, op, line: lineOf(sf, node), via }); };
  const hasMongoose = /mongoose/.test(text), hasSequelize = /sequelize/i.test(text), hasTypeorm = /typeorm/.test(text);
  const repoProps = new Map<string, string>(); // this.userRepo → User
  for (const m of text.matchAll(/(\w+)\s*:\s*Repository<\s*(\w+)\s*>/g)) repoProps.set(m[1], m[2]);
  for (const m of text.matchAll(/(\w+)\s*=\s*(?:\w+\.)?getRepository\(\s*(\w+)\s*\)/g)) repoProps.set(m[1], m[2]);
  walk(sf, (n) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const s = ts.isTemplateExpression(n) ? n.getText(sf) : n.text;
      if (s.length > 12) for (const u of sqlUsage(s)) push(u.table, u.op, "sql", n);
      return;
    }
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const method = n.expression.name.text;
    const recv = n.expression.expression;
    const chain = dotted(recv);
    // prisma.user.findMany · ctx.db.user.create · tx.order.update
    if (chain && PRISMA_OPS[method] && ts.isPropertyAccessExpression(recv)) {
      const segs = chain.split(".");
      const model = segs[segs.length - 1]; const owner = segs[segs.length - 2] ?? "";
      if (/^(prisma|db|client|tx|orm|database|p)$/i.test(owner) || /prisma/i.test(owner)) { push(model, PRISMA_OPS[method], "prisma", n); return; }
    }
    // drizzle: db.insert(users) · db.update(users) · db.delete(users) · .from(users) · db.query.users.findMany()
    if (/^(insert|update|delete)$/.test(method) && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && chain && /^(db|drizzle|tx)$/.test(chain)) { push(n.arguments[0].text, "write", "drizzle", n); return; }
    if (method === "from" && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && /\.select\(|selectDistinct\(/.test(recv.getText(sf))) { push(n.arguments[0].text, "read", "drizzle", n); return; }
    if (/^(findMany|findFirst)$/.test(method) && chain && /^(db|tx)\.query\.\w+$/.test(chain)) { push(chain.split(".")[2], "read", "drizzle", n); return; }
    // knex: knex('users') · db('users').insert() · .from('users') · .into('users') · .table('users')
    if (/^(from|into|table|withSchema)$/.test(method) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && method !== "withSchema") {
      const stmt = statementText(n, sf);
      if (/\bknex\b|\.(insert|update|del|delete|where|select|first)\(/.test(stmt)) { push(n.arguments[0].text, method === "into" || /\.(insert|update|del|delete)\(/.test(stmt) ? "write" : "read", "knex", n); return; }
    }
    if (ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && /^(knex|db|pg|k)$/.test(recv.expression.text) && recv.arguments[0] && ts.isStringLiteralLike(recv.arguments[0]) && /^(select|where|first|insert|update|del|delete|join|count|orderBy|limit|returning|increment|decrement)$/.test(method)) {
      push(recv.arguments[0].text, /^(insert|update|del|delete|increment|decrement)$/.test(method) ? "write" : /\.(insert|update|del|delete)\(/.test(statementText(n, sf)) ? "write" : "read", "knex", n); return;
    }
    // typeorm: this.userRepo.find() · repo.save() · getRepository(User).find()
    if (TYPEORM_OPS[method]) {
      if (ts.isCallExpression(recv) && /getRepository|getTreeRepository|getMongoRepository/.test(recv.expression.getText(sf)) && recv.arguments[0] && ts.isIdentifier(recv.arguments[0])) { push(recv.arguments[0].text, TYPEORM_OPS[method], "typeorm", n); return; }
      const last = chain?.split(".").pop();
      if (last && repoProps.has(last)) { push(repoProps.get(last)!, TYPEORM_OPS[method], "typeorm", n); return; }
      if (hasTypeorm && last && /repo(sitory)?$/i.test(last)) { push(last.replace(/repo(sitory)?$/i, ""), TYPEORM_OPS[method], "typeorm", n); return; }
    }
    // mongoose / sequelize: User.find() · Order.create() · User.findAll()
    if (MONGOOSE_OPS[method] && ts.isIdentifier(recv) && /^[A-Z]\w*$/.test(recv.text) && (hasMongoose || hasSequelize || /\b(model|models)\b/i.test(text))) {
      if (recv.text === "JSON" || recv.text === "Object" || recv.text === "Promise") return;
      push(recv.text, MONGOOSE_OPS[method], "mongoose", n); return;
    }
  });
  // `new User({...}).save()` · `doc.save()` on a model instance is too fuzzy; only the explicit constructor form:
  for (const m of text.matchAll(/new\s+([A-Z]\w*)\s*\([^)]*\)\s*\)?\s*\.save\(/g)) if (hasMongoose || hasSequelize) out.push({ file: rel, table: m[1], op: "write", line: lineOfOffset(text, m.index!), via: "mongoose" });
}

function statementText(n: ts.Node, sf: ts.SourceFile): string {
  let p: ts.Node = n;
  while (p.parent && !ts.isStatement(p.parent) && !ts.isSourceFile(p.parent)) p = p.parent;
  return p.getText(sf).slice(0, 600);
}

function scanPy(rel: string, text: string, out: OrmUsageFact[]) {
  const push = (table: string, op: Op, via: OrmUsageFact["via"], idx: number) => out.push({ file: rel, table, op, line: lineOfOffset(text, idx), via });
  // raw SQL in string literals
  for (const m of text.matchAll(/(?:"""|'''|"|')((?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*?)(?:"""|'''|"|')/gi)) for (const u of sqlUsage(m[1])) push(u.table, u.op, "sql", m.index!);
  if (/sqlalchemy|session|select\(/i.test(text)) {
    const varModel = new Map<string, string>(); // obj = Item(...) → Item
    for (const m of text.matchAll(/\b(\w+)\s*=\s*([A-Z]\w*)\s*\(/g)) if (!/^(Column|Session|String|Integer|Float|Boolean|DateTime|Depends|Field|APIRouter|FastAPI|Flask|Blueprint)$/.test(m[2])) varModel.set(m[1], m[2]);
    for (const m of text.matchAll(/\b(?:session|db\.session|db|s|sess|conn|self\.session|self\.db)\.query\(\s*([A-Z]\w*)/g)) push(m[1], "read", "sqlalchemy", m.index!);
    for (const m of text.matchAll(/\bselect\(\s*([A-Z]\w*)/g)) push(m[1], "read", "sqlalchemy", m.index!);
    for (const m of text.matchAll(/\b(?:insert|update|delete)\(\s*([A-Z]\w*)\s*\)/g)) push(m[1], "write", "sqlalchemy", m.index!);
    for (const m of text.matchAll(/\.add(?:_all)?\(\s*(?:\[\s*)?([A-Z]\w*)\s*\(/g)) push(m[1], "write", "sqlalchemy", m.index!);
    for (const m of text.matchAll(/\.add(?:_all)?\(\s*(?:\[\s*)?([a-z_]\w*)\s*[\],)]/g)) { const mod = varModel.get(m[1]); if (mod) push(mod, "write", "sqlalchemy", m.index!); }
    for (const m of text.matchAll(/\b([A-Z]\w*)\.query\.(?:filter|filter_by|get|all|first|count|order_by)\b/g)) push(m[1], "read", "sqlalchemy", m.index!);
    for (const m of text.matchAll(/\b(?:session|db\.session)\.(?:delete)\(\s*(\w+)/g)) push(m[1], "write", "sqlalchemy", m.index!);
  }
  if (/objects\./.test(text)) {
    for (const m of text.matchAll(/\b([A-Z]\w*)\.objects\.(filter|get|all|exclude|values|values_list|count|exists|first|last|order_by|select_related|prefetch_related|annotate|aggregate|get_or_create|update_or_create|create|bulk_create|update|delete|bulk_update)\b/g))
      push(m[1], /create|update|delete/.test(m[2]) ? "write" : "read", "django", m.index!);
  }
}

export const ormUsageExtractor: Extractor = {
  name: "orm-usage",
  applies() { return true; },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const ormUsage: OrmUsageFact[] = [];
    for (const f of ctx.files) {
      const isPy = f.rel.endsWith(".py");
      if (!(isCodeFile(f) || (isPy && !isSkipped(f.rel) && f.size <= MAX_FILE_BYTES)) || isTestFile(f.rel)) continue;
      if (/\.d\.ts$|(^|\/)(migrations?|seeds?)\//.test(f.rel)) continue;
      const text = await safeRead(ctx, f.rel); if (text === undefined) continue;
      try {
        if (isPy) scanPy(f.rel, text, ormUsage);
        else if (/\.(find|create|update|delete|upsert|count|aggregate|insert|select|from|into|save|remove|query)\w*\(|SELECT|INSERT|UPDATE|DELETE/i.test(text)) scanJs(f.rel, text, ormUsage);
      } catch (e) { ctx.log(`orm-usage: failed on ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    // de-dupe (file, table, op, line)
    const seen = new Set<string>();
    const out = ormUsage.filter((u) => { const k = `${u.file}|${u.table}|${u.op}|${u.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
    ctx.log(`orm-usage: ${out.length} usages`);
    return { ormUsage: out };
  },
};
