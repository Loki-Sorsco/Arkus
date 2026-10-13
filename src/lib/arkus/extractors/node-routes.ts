// Node backend routes: Express / Fastify / Hono / Koa-router, NestJS controllers, tRPC routers.
import ts from "typescript";
import { normalizePath } from "../types";
import type { ExtractContext, Extractor, RouteFact, Facts, HttpMethod } from "../types";
import { parseTs, lineOf, walk, idName, dotted, strValue, getProp, isCodeFile, isTestFile, resolveImport, fileSetOf, imports, safeRead, toMethod } from "./util";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const AUTH_RE = /\b(requireAuth|requiresAuth|ensureAuth|ensureAuthenticated|isAuthenticated|isAuth|authenticate[d]?|authMiddleware|authGuard|protect|verifyToken|verifyJwt|checkJwt|jwtCheck|passport\.|jwt\(|expressjwt|bearerAuth|withAuth|requireUser|requireLogin|auth\b)/i;
const NEST_VERBS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All"]);

interface FileInfo {
  rel: string; sf: ts.SourceFile;
  routes: { receiver: string; method: HttpMethod; path: string; line: number; auth: boolean | "unknown"; bodyKeys?: { name: string }[]; handlerName?: string; framework: string }[];
  mounts: { prefix: string; target: string; targetFile?: string; line: number }[]; // app.use('/p', router)
  receiverAuth: Map<string, number>; // receiver → line where router-level auth middleware was attached
  basePath?: string;
  exportsRouter: Set<string>; // names exported (default → "default")
}

function bodyKeysFromHandler(text: string): { name: string }[] | undefined {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\{\s*([^{}=]*?)\s*\}\s*=\s*(?:await\s+)?(?:req|request|ctx\.request)\.body\b/g)) for (const k of m[1].split(",")) { const n = k.split(":")[0].trim().replace(/\s*=.*$/, ""); if (/^\w+$/.test(n)) keys.add(n); }
  for (const m of text.matchAll(/\{\s*([^{}=]*?)\s*\}\s*=\s*(?:await\s+)?c\.req\.(?:json|parseBody|valid)\([^)]*\)/g)) for (const k of m[1].split(",")) { const n = k.split(":")[0].trim(); if (/^\w+$/.test(n)) keys.add(n); }
  for (const m of text.matchAll(/(?:req|request|ctx\.request)\.body\.(\w+)/g)) keys.add(m[1]);
  for (const m of text.matchAll(/\bz\.object\(\s*\{([^}]*)\}/g)) for (const k of m[1].split(",")) { const n = k.split(":")[0].trim(); if (/^\w+$/.test(n)) keys.add(n); }
  return keys.size ? [...keys].map((name) => ({ name })) : undefined;
}

function isFnLike(n: ts.Node): boolean {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isCallExpression(n) || ts.isArrayLiteralExpression(n);
}

function scanExpressLike(info: FileInfo, fileSet: Set<string>) {
  const { sf, rel } = info;
  const imp = imports(sf);
  const axiosLike = new Set<string>(["axios", "fetch", "ky", "got", "superagent", "request"]);
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const t = n.initializer.getText(sf);
      if (/axios\.create\(|\baxios\b|\bky\.(create|extend)\(/.test(t)) axiosLike.add(n.name.text);
      if (/new Hono\(\)\.basePath\(/.test(t)) { const m = /basePath\(\s*["'`]([^"'`]+)/.exec(t); if (m) info.basePath = m[1]; }
    }
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const verb = n.expression.name.text;
    const recvNode = n.expression.expression;
    let receiver = dotted(recvNode);
    let routeBase = "";
    // app.route('/x').get(handler)
    if (!receiver && ts.isCallExpression(recvNode) && ts.isPropertyAccessExpression(recvNode.expression) && recvNode.expression.name.text === "route") {
      receiver = dotted(recvNode.expression.expression);
      routeBase = strValue(recvNode.arguments[0], sf)?.text ?? "";
    }
    // chained: router.get(...).post(...) — walk down to the root receiver
    if (!receiver && ts.isCallExpression(recvNode)) { let c: ts.Node = recvNode; while (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression)) c = c.expression.expression; receiver = dotted(c); }
    if (!receiver) return;
    const root = receiver.split(".")[0];
    if (axiosLike.has(root) || root === "this" || root === "window") return;
    const args = n.arguments;
    const lineN = lineOf(sf, n);

    if (verb === "use" || verb === "register" || (verb === "route" && args.length === 2 && ts.isIdentifier(args[1]))) {
      // mounts: app.use('/prefix', router) · app.use(authMw) · fastify.register(routes, { prefix }) · hono app.route('/p', sub)
      const first = args[0];
      const pathV = first ? strValue(first, sf) : undefined;
      const targets = (pathV ? args.slice(1) : [...args]).filter((a) => ts.isIdentifier(a) || (ts.isCallExpression(a) && idName(a.expression) === "require"));
      let prefix = pathV?.text ?? "";
      if (verb === "register") { const opt = args[1]; const p = getProp(opt, "prefix"); const pv = p ? strValue(p, sf) : undefined; prefix = pv?.text ?? ""; }
      for (const t of targets) {
        let name = ts.isIdentifier(t) ? t.text : undefined;
        let targetFile: string | undefined;
        if (!name && ts.isCallExpression(t) && ts.isStringLiteral(t.arguments[0])) { name = t.arguments[0].text; targetFile = resolveImport(name, rel, fileSet); }
        if (!name) continue;
        if (!targetFile && imp.has(name)) targetFile = resolveImport(imp.get(name)!.spec, rel, fileSet);
        if (AUTH_RE.test(name) && !targetFile) { info.receiverAuth.set(root, lineN); continue; }
        info.mounts.push({ prefix, target: name, targetFile, line: lineN });
      }
      if (!pathV && args.some((a) => AUTH_RE.test(a.getText(sf)) && !/passport\.(initialize|session)\(/.test(a.getText(sf)))) info.receiverAuth.set(root, lineN);
      return;
    }
    if (!VERBS.has(verb) && verb !== "route") return;
    if (verb === "route" && ts.isObjectLiteralExpression(args[0])) { // fastify.route({ method, url, handler })
      const o = args[0];
      const url = strValue(getProp(o, "url") ?? getProp(o, "path"), sf);
      const mv = getProp(o, "method");
      const methods = mv ? (ts.isArrayLiteralExpression(mv) ? mv.elements.map((e) => strValue(e, sf)?.text ?? "ANY") : [strValue(mv, sf)?.text ?? "ANY"]) : ["ANY"];
      if (url) for (const m of methods) info.routes.push({ receiver: root, method: toMethod(m), path: url.text, line: lineN, auth: AUTH_RE.test(o.getText(sf)) ? true : "unknown", bodyKeys: bodyKeysFromHandler(o.getText(sf)), framework: "fastify" });
      return;
    }
    if (verb === "route") return;
    const pathArg = routeBase ? undefined : args[0];
    const pathV = routeBase ? { text: routeBase, dynamic: false } : strValue(pathArg, sf);
    if (!pathV) return;
    const rest = routeBase ? [...args] : args.slice(1);
    if (rest.length === 0 || !rest.some(isFnLike)) return; // axios-style call, not a route
    if (rest.length === 1 && ts.isObjectLiteralExpression(rest[0])) return;
    const restText = rest.map((a) => a.getText(sf)).join("\n");
    const handler = rest[rest.length - 1];
    const handlerName = ts.isIdentifier(handler) ? handler.text : ts.isPropertyAccessExpression(handler) ? dotted(handler) : undefined;
    const auth = AUTH_RE.test(rest.slice(0, -1).map((a) => a.getText(sf)).join(" ")) || (info.receiverAuth.has(root) && info.receiverAuth.get(root)! < lineN) ? true : "unknown";
    const fw = /fastify|server/.test(root) && /fastify/.test(sf.text) ? "fastify" : /\bHono\b/.test(sf.text) ? "hono" : /koa/i.test(sf.text) ? "koa" : "express";
    const bodyText = handlerName && !ts.isArrowFunction(handler) ? restText + "\n" + handlerSourceByName(sf, handlerName) : restText;
    info.routes.push({ receiver: root, method: toMethod(verb), path: pathV.text, line: lineN, auth, bodyKeys: bodyKeysFromHandler(bodyText), handlerName, framework: fw });
  });
  // exports
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) info.exportsRouter.add("default");
    if (ts.isExpressionStatement(st) && /module\.exports\s*=/.test(st.getText(sf))) info.exportsRouter.add("default");
    if (ts.isVariableStatement(st) && ts.getCombinedModifierFlags(st.declarationList.declarations[0]) & ts.ModifierFlags.Export) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) info.exportsRouter.add(d.name.text);
  }
}

function handlerSourceByName(sf: ts.SourceFile, name: string): string {
  const base = name.split(".").pop()!;
  let text = "";
  walk(sf, (n) => {
    if (text) return false;
    if ((ts.isFunctionDeclaration(n) && n.name?.text === base) || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === base)) text = n.getText(sf);
    if ((ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) && idName(n.name) === base) text = n.getText(sf);
  });
  return text;
}

/** Resolve mount prefixes across files: returns map file → prefixes[] (multiple mounts → multiple prefixes). */
function resolvePrefixes(infos: Map<string, FileInfo>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const memo = new Map<string, string[]>();
  const prefixesForFile = (rel: string, depth: number): string[] => {
    if (depth > 5) return [""];
    if (memo.has(rel)) return memo.get(rel)!;
    const found: string[] = [];
    for (const info of infos.values()) for (const m of info.mounts) if (m.targetFile === rel) {
      for (const p of prefixesForFile(info.rel, depth + 1)) found.push(p + m.prefix);
    }
    const res = found.length ? found : [""];
    memo.set(rel, res);
    return res;
  };
  for (const rel of infos.keys()) out.set(rel, prefixesForFile(rel, 0));
  return out;
}

function scanNest(info: FileInfo, fileSet: Set<string>, ctx: ExtractContext, out: RouteFact[], globalPrefix: string): Promise<void>[] {
  const { sf, rel } = info;
  const imp = imports(sf);
  const pending: Promise<void>[] = [];
  const decoratorsOf = (n: ts.Node) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []);
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st)) continue;
    const ctrl = decoratorsOf(st).map((d) => d.expression).find((e) => ts.isCallExpression(e) && idName(e.expression) === "Controller") as ts.CallExpression | undefined;
    if (!ctrl) continue;
    const a0 = ctrl.arguments[0];
    const prefix = a0 ? (strValue(a0, sf)?.text ?? strValue(getProp(a0, "path"), sf)?.text ?? "") : "";
    const classAuth = decoratorsOf(st).some((d) => /UseGuards|Auth\(/.test(d.getText(sf)));
    for (const mem of st.members) {
      if (!ts.isMethodDeclaration(mem)) continue;
      for (const d of decoratorsOf(mem)) {
        const e = d.expression;
        if (!ts.isCallExpression(e)) continue;
        const dn = idName(e.expression) ?? "";
        if (!NEST_VERBS.has(dn)) continue;
        const sub = e.arguments[0] ? (strValue(e.arguments[0], sf)?.text ?? "") : "";
        const path = normalizePath(`${globalPrefix}/${prefix}/${sub}`);
        const auth = classAuth || decoratorsOf(mem).some((x) => /UseGuards|Auth\(/.test(x.getText(sf))) ? true : "unknown";
        const fact: RouteFact = { method: toMethod(dn), path, framework: "nestjs", file: rel, line: lineOf(sf, mem), handlerName: idName(mem.name), auth, confidence: globalPrefix ? 0.8 : 1, evidence: [{ kind: "static", file: rel, line: lineOf(sf, mem) }] };
        out.push(fact);
        for (const p of mem.parameters) {
          const bd = decoratorsOf(p).find((x) => ts.isCallExpression(x.expression) && idName(x.expression.expression) === "Body");
          if (!bd) continue;
          const bodyArg = ts.isCallExpression(bd.expression) ? bd.expression.arguments[0] : undefined;
          if (bodyArg && ts.isStringLiteralLike(bodyArg)) { fact.bodyKeys = [...(fact.bodyKeys ?? []), { name: bodyArg.text }]; continue; }
          const tn = p.type && ts.isTypeReferenceNode(p.type) ? idName(p.type.typeName) : undefined;
          if (!tn) continue;
          const local = dtoFromFile(sf, tn);
          if (local) { fact.bodyKeys = local; continue; }
          const i = imp.get(tn);
          const target = i ? resolveImport(i.spec, rel, fileSet) : undefined;
          if (target) pending.push(safeRead(ctx, target).then((t) => { if (t) fact.bodyKeys = dtoFromFile(parseTs(target, t), tn) ?? fact.bodyKeys; }));
        }
      }
    }
  }
  return pending;
}

function dtoFromFile(sf: ts.SourceFile, className: string): RouteFact["bodyKeys"] | undefined {
  for (const st of sf.statements) {
    if ((ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name?.text === className) {
      const keys: NonNullable<RouteFact["bodyKeys"]> = [];
      for (const m of st.members) {
        if ((ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) && m.name) {
          const decos = ts.canHaveDecorators(m) ? (ts.getDecorators(m) ?? []).map((d) => d.getText(sf)).join(" ") : "";
          keys.push({ name: idName(m.name)!, type: m.type?.getText(sf), required: !(m.questionToken || /IsOptional/.test(decos)), validation: decos || undefined });
        }
      }
      return keys;
    }
    if (ts.isTypeAliasDeclaration(st) && st.name.text === className && ts.isTypeLiteralNode(st.type)) {
      return st.type.members.filter(ts.isPropertySignature).map((m) => ({ name: idName(m.name)!, type: m.type?.getText(sf), required: !m.questionToken }));
    }
  }
  return undefined;
}

interface TrpcRouter { name: string; file: string; procs: RouteFact[]; children: { key: string; ident: string }[] }

function scanTrpc(info: FileInfo): TrpcRouter[] {
  const { sf, rel } = info;
  const routers: TrpcRouter[] = [];
  const isRouterCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && /^(router|createTRPCRouter|createRouter)$/.test(idName(n.expression) ?? "") && !!n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0]);
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer || !isRouterCall(n.initializer)) return;
    const varName = n.name.text;
    const r: TrpcRouter = { name: varName.replace(/Router$/, "").replace(/^app$/, ""), file: rel, procs: [], children: [] };
    for (const p of (n.initializer.arguments[0] as ts.ObjectLiteralExpression).properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = idName(p.name); if (!key) continue;
      if (ts.isIdentifier(p.initializer)) { r.children.push({ key, ident: p.initializer.text }); continue; }
      if (isRouterCall(p.initializer)) continue; // inline nested router: skip (rare)
      // walk the call chain: publicProcedure.input(z.object({..})).mutation(fn)
      let kind: "query" | "mutation" | "subscription" | undefined; let inputKeys: string[] = []; let base = "";
      let c: ts.Node = p.initializer;
      while (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression)) {
        const nm = c.expression.name.text;
        if (nm === "query" || nm === "mutation" || nm === "subscription") kind = nm;
        if (nm === "input" && c.arguments[0]) { const zt = c.arguments[0].getText(sf); const m = /z\.object\(\s*\{([\s\S]*?)\}\s*\)/.exec(zt); if (m) inputKeys = m[1].split(/,\s*\n?/).map((s) => s.split(":")[0].trim()).filter((s) => /^\w+$/.test(s)); }
        c = c.expression.expression;
      }
      base = dotted(c) ?? "";
      if (!kind) continue;
      const auth = /protected|private|auth|admin/i.test(base) ? true : /public/i.test(base) ? false : "unknown";
      r.procs.push({ method: kind === "mutation" ? "POST" : "GET", path: `/trpc/${r.name ? r.name + "." : ""}${key}`, framework: "trpc", file: rel, line: lineOf(sf, p), handlerName: key, auth, bodyKeys: inputKeys.length ? inputKeys.map((name) => ({ name })) : undefined, confidence: 1, evidence: [{ kind: "static", file: rel, line: lineOf(sf, p) }] });
    }
    routers.push(r);
  });
  return routers;
}

export const nodeRoutesExtractor: Extractor = {
  name: "node-routes",
  applies(det, files) {
    const fw = det.frameworks;
    if (fw.some((f) => ["express", "fastify", "hono", "koa", "nestjs", "trpc"].includes(f))) return true;
    return fw.length === 0 || files.some((f) => /\.(controller|routes?|router)\.[jt]s$/.test(f.rel) || /(^|\/)(routes|routers|controllers|trpc|server)\//.test(f.rel));
  },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const fileSet = fileSetOf(ctx.files);
    const infos = new Map<string, FileInfo>();
    let globalPrefix = "";
    const routes: RouteFact[] = [];
    const nestPending: Promise<void>[] = [];
    const trpcRouters: TrpcRouter[] = [];
    for (const f of ctx.files) {
      if (!isCodeFile(f) || isTestFile(f.rel) || /\.(tsx|jsx)$/.test(f.rel) || /(^|\/)(app|pages)\/.*\/(route|page)\.[jt]sx?$/.test(f.rel)) continue;
      const text = await safeRead(ctx, f.rel);
      if (text === undefined) continue;
      if (!/\.(get|post|put|patch|delete|all|use|route|register)\s*\(|@Controller|router\(|createTRPCRouter|createRouter/.test(text)) continue;
      try {
        const sf = parseTs(f.rel, text);
        const info: FileInfo = { rel: f.rel, sf, routes: [], mounts: [], receiverAuth: new Map(), exportsRouter: new Set() };
        const gp = /setGlobalPrefix\(\s*["'`]([^"'`]+)/.exec(text); if (gp) globalPrefix = gp[1];
        if (/@Controller\(/.test(text)) nestPending.push(...scanNest(info, fileSet, ctx, routes, ""));
        if (/createTRPCRouter|\brouter\(\s*\{|t\.router\(|createRouter\(/.test(text)) trpcRouters.push(...scanTrpc(info));
        scanExpressLike(info, fileSet);
        infos.set(f.rel, info);
      } catch (e) { ctx.log(`node-routes: failed on ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    await Promise.all(nestPending);
    if (globalPrefix) for (const r of routes) if (r.framework === "nestjs") { r.path = normalizePath(`/${globalPrefix}${r.path}`); r.confidence = 0.8; }
    const prefixes = resolvePrefixes(infos);
    for (const info of infos.values()) {
      const base = info.basePath ?? "";
      const localMount = new Map<string, string>(); // receiver → prefix (same-file mounts)
      for (const m of info.mounts) if (!m.targetFile) localMount.set(m.target, m.prefix);
      for (const r of info.routes) {
        const filePrefixes = prefixes.get(info.rel) ?? [""];
        const local = localMount.get(r.receiver) ?? "";
        for (const fp of filePrefixes) {
          const resolved = fp || local;
          routes.push({ method: r.method, path: normalizePath(`${base}${fp}${local}${r.path}`), framework: r.framework, file: info.rel, line: r.line, handlerName: r.handlerName, auth: r.auth, bodyKeys: r.bodyKeys, confidence: resolved ? 0.8 : 1, evidence: [{ kind: "static", file: info.rel, line: r.line, note: resolved ? `mounted at ${resolved}` : undefined }] });
        }
      }
    }
    // tRPC: re-prefix sub-routers composed into a parent (appRouter = router({ user: userRouter }))
    const byIdent = new Map<string, TrpcRouter>();
    for (const r of trpcRouters) { const info = infos.get(r.file)!; const varName = r.name ? r.name + "Router" : "appRouter"; byIdent.set(`${r.file}:${varName}`, r); byIdent.set(`${r.file}:${r.name}`, r); void info; }
    for (const parent of trpcRouters) {
      const imp = imports(infos.get(parent.file)!.sf);
      for (const ch of parent.children) {
        const i = imp.get(ch.ident);
        const file = i ? resolveImport(i.spec, parent.file, fileSet) : parent.file;
        const child = file ? (byIdent.get(`${file}:${ch.ident}`) ?? trpcRouters.find((r) => r.file === file && (r.name + "Router" === ch.ident || r.name === ch.ident))) : undefined;
        if (child) for (const p of child.procs) p.path = `/trpc/${ch.key}.${p.handlerName}`;
      }
    }
    for (const r of trpcRouters) routes.push(...r.procs);
    for (const r of routes) r.path = normalizePath(r.path);
    ctx.log(`node-routes: ${routes.length} routes`);
    return { routes };
  },
};


