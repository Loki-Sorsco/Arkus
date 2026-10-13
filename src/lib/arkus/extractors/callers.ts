// Frontend API calls: fetch, axios (+ instances), react-query / SWR, RTK Query, tRPC client, server actions.
import ts from "typescript";
import { normalizePath } from "../types";
import type { ExtractContext, Extractor, ApiCallFact, Facts, HttpMethod } from "../types";
import { parseTs, lineOf, walk, idName, dotted, strValue, objectKeys, getProp, findVarInit, isCodeFile, isTestFile, resolveImport, fileSetOf, imports, safeRead, toMethod } from "./util";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);
const INSTANCE_NAME = /^(api|http|client|apiClient|axiosInstance|instance|httpClient|axiosClient|\$api|\$http)$/i;
const ENV_URL = /^(?:\$\{[^}]*\}|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?)/;

/** Normalize a URL-ish string into a path for the graph. Full external URLs are kept whole. */
function toPath(raw: string, baseURL = ""): { path: string; dynamic: boolean } {
  let s = raw.trim();
  let dynamic = /:param|\$\{/.test(s);
  if (ENV_URL.test(s)) { s = s.replace(ENV_URL, ""); dynamic = dynamic || true; }
  if (/^https?:\/\//.test(s)) return { path: s.replace(/\?.*$/, ""), dynamic };
  s = s.replace(/[?#].*$/, "");
  if (!s.startsWith("/")) s = "/" + s;
  if (baseURL && !/^https?:/.test(baseURL)) s = baseURL.replace(/\/$/, "") + s;
  return { path: normalizePath(s), dynamic };
}

function bodyKeysFrom(n: ts.Node | undefined, sf: ts.SourceFile): string[] | undefined {
  if (!n) return undefined;
  if (ts.isCallExpression(n) && dotted(n.expression) === "JSON.stringify") return bodyKeysFrom(n.arguments[0], sf);
  if (ts.isObjectLiteralExpression(n)) { const k = objectKeys(n).filter((x) => x !== "..."); return k.length ? k : undefined; }
  if (ts.isIdentifier(n)) { const init = findVarInit(sf, n.text); if (init && !ts.isIdentifier(init)) return bodyKeysFrom(init, sf); }
  if (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n)) return bodyKeysFrom(n.expression, sf);
  return undefined;
}

/** `cond ? "a" : "b"` → both branches; otherwise the single string value. */
function strValues(n: ts.Node | undefined, sf: ts.SourceFile): { text: string; dynamic?: boolean }[] {
  if (!n) return [];
  if (ts.isParenthesizedExpression(n)) return strValues(n.expression, sf);
  if (ts.isConditionalExpression(n)) return [...strValues(n.whenTrue, sf), ...strValues(n.whenFalse, sf)];
  const v = strValue(n, sf);
  return v ? [v] : [];
}

function methodFromOptions(opts: ts.Node | undefined, sf: ts.SourceFile): { method: HttpMethod; methods: HttpMethod[]; bodyKeys?: string[] } {
  if (!opts) return { method: "GET", methods: ["GET"] };
  let o: ts.Node | undefined = opts;
  if (ts.isIdentifier(o)) o = findVarInit(sf, o.text);
  if (!o || !ts.isObjectLiteralExpression(o)) return { method: "GET", methods: ["GET"] };
  const mv = getProp(o, "method");
  const ms = mv ? strValues(mv, sf).map((v) => toMethod(v.text)) : [];
  const body = getProp(o, "body") ?? getProp(o, "data") ?? getProp(o, "json");
  const methods = ms.length ? ms : [body ? "POST" as HttpMethod : "GET" as HttpMethod];
  return { method: methods[0], methods, bodyKeys: bodyKeysFrom(body, sf) };
}

function libFor(n: ts.Node, sf: ts.SourceFile, base: string): string {
  let p: ts.Node | undefined = n.parent;
  while (p) {
    if (ts.isCallExpression(p)) {
      const nm = idName(p.expression) ?? "";
      if (/^use(Query|Mutation|InfiniteQuery|SuspenseQuery|Queries)$/.test(nm) || nm === "queryOptions") return "react-query";
      if (/^useSWR|^useSWRMutation|^useSWRInfinite/.test(nm)) return "swr";
    }
    p = p.parent;
  }
  void sf;
  return base;
}

export const callersExtractor: Extractor = {
  name: "callers",
  applies() { return true; },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const fileSet = fileSetOf(ctx.files);
    const apicalls: ApiCallFact[] = [];
    const files = ctx.files.filter((f) => isCodeFile(f) && !isTestFile(f.rel));
    // pass 1: files that export an axios instance (so other files can import it) + files with "use server"
    const instanceExports = new Map<string, Map<string, string>>(); // file → exported instance name ("default" included) → baseURL path
    const serverActionFiles = new Set<string>();
    const texts = new Map<string, string>();
    for (const f of files) {
      const t = await safeRead(ctx, f.rel); if (t === undefined) continue;
      texts.set(f.rel, t);
      if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(t)) serverActionFiles.add(f.rel);
      if (/axios\.create\(|\bky\.(create|extend)\(/.test(t)) {
        const names = new Map<string, string>();
        const baseOfText = (s: string) => { const b = /(?:baseURL|prefixUrl)\s*:\s*(["'`])([^"'`]*)\1/.exec(s); return b ? toPath(b[2]).path.replace(/^\/$/, "") : ""; };
        for (const m of t.matchAll(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:axios\.create|ky\.(?:create|extend))\(([\s\S]{0,300}?)\)\s*;?/g)) names.set(m[1], baseOfText(m[2]));
        const def = /export\s+default\s+(\w+)/.exec(t);
        if (def) names.set("default", names.get(def[1]) ?? baseOfText(t)); else if (/export\s+default\s+axios\.create/.test(t)) names.set("default", baseOfText(t));
        for (const m of t.matchAll(/export\s+\{\s*([^}]+)\}/g)) for (const n of m[1].split(",")) { const [orig, alias] = n.trim().split(/\s+as\s+/); if (orig) names.set(alias ?? orig, names.get(orig) ?? ""); }
        instanceExports.set(f.rel, names);
      }
    }
    for (const f of files) {
      const text = texts.get(f.rel); if (text === undefined) continue;
      if (!/fetch\s*\(|axios|useSWR|useQuery|useMutation|builder\.(query|mutation)|\.useQuery\(|\.useMutation\(|\.mutate\(|\.query\(|action=/.test(text)) continue;
      try {
        const sf = parseTs(f.rel, text);
        const imp = imports(sf);
        const instances = new Map<string, string>(); // local name → baseURL path
        let rtkBase = "";
        const baseOf = (createCall: ts.Node): string => { const b = strValue(getProp(ts.isCallExpression(createCall) ? createCall.arguments[0] : undefined, "baseURL"), sf); return b ? toPath(b.text).path.replace(/^\/$/, "") : ""; };
        walk(sf, (n) => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && /^(axios\.create|ky\.create|ky\.extend)$/.test(dotted(n.initializer.expression) ?? "")) instances.set(n.name.text, baseOf(n.initializer));
          if (ts.isCallExpression(n) && idName(n.expression) === "fetchBaseQuery") { const b = strValue(getProp(n.arguments[0], "baseUrl"), sf); if (b) rtkBase = toPath(b.text).path.replace(/^\/$/, ""); }
        });
        for (const [local, i] of imp) {
          const target = resolveImport(i.spec, f.rel, fileSet);
          const exp = target ? instanceExports.get(target) : undefined;
          if (exp?.has(i.imported)) instances.set(local, exp.get(i.imported) ?? "");
          if (!target && /axios/.test(i.spec) && i.isDefault) instances.set(local, "");
        }
        const used = new Set<string>();
        const emit = (fact: ApiCallFact) => { const k = `${fact.line}:${fact.method}:${fact.path}`; if (used.has(k)) return; used.add(k); apicalls.push(fact); };

        walk(sf, (n) => {
          if (!ts.isCallExpression(n)) return;
          const callee = n.expression;
          const calleeName = dotted(callee) ?? "";
          const line = lineOf(sf, n);
          // fetch(url, opts)
          if (/^(fetch|window\.fetch|globalThis\.fetch|ky|got)$/.test(calleeName) && n.arguments[0]) {
            const us = strValues(n.arguments[0], sf);
            const mo = methodFromOptions(n.arguments[1], sf);
            if (!us.length) { emit({ fromFile: f.rel, method: mo.method, path: "/:dynamic", line, dynamic: true, lib: libFor(n, sf, "fetch") }); return; }
            // `existing ? \`/x/${id}\` : "/x"` with `method: existing ? "PATCH" : "POST"` → pair branches by position
            us.forEach((u, i) => { const p = toPath(u.text); const method = mo.methods[us.length === mo.methods.length ? i : 0]; emit({ fromFile: f.rel, method, path: p.path, line, dynamic: p.dynamic || u.dynamic || undefined, bodyKeys: mo.bodyKeys, lib: libFor(n, sf, "fetch") }); });
            return;
          }
          // axios.get(url, data?, cfg?) · api.post(...) · axios({ url, method })
          if (ts.isPropertyAccessExpression(callee)) {
            const root = dotted(callee.expression) ?? "";
            const verb = callee.name.text;
            const isInstance = root === "axios" || instances.has(root) || (INSTANCE_NAME.test(root) && !n.arguments.slice(1).some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
            if (isInstance && VERBS.has(verb) && n.arguments[0]) {
              const base = instances.get(root) ?? "";
              if (verb === "request") { const mo = methodFromOptions(n.arguments[0], sf); const u = strValue(getProp(n.arguments[0], "url"), sf); if (u) { const p = toPath(u.text, base); emit({ fromFile: f.rel, method: mo.method, path: p.path, line, dynamic: p.dynamic || undefined, bodyKeys: mo.bodyKeys, lib: libFor(n, sf, "axios") }); } return; }
              const u = strValue(n.arguments[0], sf);
              if (!u) { emit({ fromFile: f.rel, method: toMethod(verb), path: "/:dynamic", line, dynamic: true, lib: libFor(n, sf, "axios") }); return; }
              const p = toPath(u.text, base);
              const bodyArg = ["post", "put", "patch"].includes(verb) ? n.arguments[1] : undefined;
              emit({ fromFile: f.rel, method: toMethod(verb), path: p.path, line, dynamic: p.dynamic || u.dynamic || undefined, bodyKeys: bodyKeysFrom(bodyArg, sf), lib: libFor(n, sf, "axios") });
              return;
            }
            // tRPC client: trpc.user.getUser.useQuery() / .useMutation() / .query() / .mutate()
            if (/^(useQuery|useMutation|useSuspenseQuery|useInfiniteQuery|query|mutate|mutation|fetch|prefetch)$/.test(verb) && /^(trpc|api|client|t|caller)\.[\w.]+$/.test(root) && root.split(".").length >= 2) {
              const segs = root.split(".").slice(1);
              if (segs.length >= 1 && !/^(get|post|put|patch|delete)$/.test(segs[segs.length - 1])) {
                emit({ fromFile: f.rel, method: /mutat/i.test(verb) ? "POST" : "GET", path: `/trpc/${segs.join(".")}`, line, lib: "trpc" });
                return;
              }
            }
          }
          // axios({ url, method, data }) · axios.request({...}) handled above
          if (calleeName === "axios" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
            const o = n.arguments[0]; const u = strValue(getProp(o, "url"), sf); if (!u) return;
            const mo = methodFromOptions(o, sf); const p = toPath(u.text);
            emit({ fromFile: f.rel, method: mo.method, path: p.path, line, dynamic: p.dynamic || undefined, bodyKeys: mo.bodyKeys, lib: "axios" });
            return;
          }
          // useSWR('/api/x') · useSWR(['/api/x', id]) · useSWRMutation('/api/x', fn)
          if (/^useSWR(Mutation|Infinite|Immutable)?$/.test(calleeName) && n.arguments[0]) {
            let keyNode: ts.Node = n.arguments[0];
            if (ts.isArrayLiteralExpression(keyNode) && keyNode.elements[0]) keyNode = keyNode.elements[0];
            if (ts.isArrowFunction(keyNode) && !ts.isBlock(keyNode.body)) keyNode = keyNode.body;
            const u = strValue(keyNode, sf);
            if (u && /^[/`$]|^https?:/.test(u.text)) { const p = toPath(u.text); emit({ fromFile: f.rel, method: calleeName === "useSWRMutation" ? "POST" : "GET", path: p.path, line, dynamic: p.dynamic || undefined, lib: "swr" }); }
            return;
          }
          // RTK Query: builder.query({ query: () => '/x' }) · builder.mutation({ query: (b) => ({ url, method, body }) })
          if (/^builder\.(query|mutation)$/.test(calleeName) && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
            const q = getProp(n.arguments[0], "query");
            const isMut = calleeName.endsWith("mutation");
            if (q && (ts.isArrowFunction(q) || ts.isFunctionExpression(q))) {
              let body: ts.Node | undefined = ts.isBlock(q.body) ? q.body.statements.find(ts.isReturnStatement)?.expression : q.body;
              if (body && ts.isParenthesizedExpression(body)) body = body.expression;
              const u = strValue(body, sf);
              if (u) { const p = toPath(u.text, rtkBase); emit({ fromFile: f.rel, method: isMut ? "POST" : "GET", path: p.path, line, dynamic: p.dynamic || undefined, lib: "rtk-query" }); }
              else if (body && ts.isObjectLiteralExpression(body)) {
                const uu = strValue(getProp(body, "url"), sf); if (!uu) return;
                const mv = getProp(body, "method"); const m = mv ? strValue(mv, sf)?.text : undefined;
                const p = toPath(uu.text, rtkBase);
                emit({ fromFile: f.rel, method: m ? toMethod(m) : isMut ? "POST" : "GET", path: p.path, line, dynamic: p.dynamic || undefined, bodyKeys: bodyKeysFrom(getProp(body, "body"), sf), lib: "rtk-query" });
              }
            }
            return;
          }
          // server action invoked from a client/page: createOrder(formData) where createOrder is imported from a "use server" file
          if (ts.isIdentifier(callee) && imp.has(callee.text)) {
            const t = resolveImport(imp.get(callee.text)!.spec, f.rel, fileSet);
            if (t && serverActionFiles.has(t)) emit({ fromFile: f.rel, method: "POST", path: `/_action/${imp.get(callee.text)!.imported === "default" ? callee.text : imp.get(callee.text)!.imported}`, line, lib: "server-action", bodyKeys: bodyKeysFrom(n.arguments[0], sf) });
          }
        });
        // <form action={createOrder}> with an imported server action
        walk(sf, (n) => {
          if (ts.isJsxAttribute(n) && idName(n.name) === "action" && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression && ts.isIdentifier(n.initializer.expression)) {
            const id = n.initializer.expression.text; const i = imp.get(id); if (!i) return;
            const t = resolveImport(i.spec, f.rel, fileSet);
            if (t && serverActionFiles.has(t)) emit({ fromFile: f.rel, method: "POST", path: `/_action/${i.imported === "default" ? id : i.imported}`, line: lineOf(sf, n), lib: "server-action" });
          }
        });
      } catch (e) { ctx.log(`callers: failed on ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    ctx.log(`callers: ${apicalls.length} api calls`);
    return { apicalls };
  },
};
