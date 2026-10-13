// Next.js: App Router route handlers, Pages Router API routes, Server Actions and screens (+ form fields).
import ts from "typescript";
import { normalizePath } from "../types";
import type { ExtractContext, Extractor, RouteFact, ScreenFact, Facts, RepoFile } from "../types";
import { parseTs, lineOf, walk, idName, isSkipped, isTestFile, MAX_FILE_BYTES, resolveImport, fileSetOf, imports, humanize, safeRead, basename } from "./util";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const APP_ROUTE = /(?:^|\/)app\/(.*?)\/?route\.(?:ts|js|tsx|jsx|mjs)$/;
const APP_PAGE = /(?:^|\/)app\/(.*?)\/?page\.(?:tsx|jsx|ts|js)$/;
const PAGES_API = /(?:^|\/)pages\/api\/(.+)\.(?:ts|js|tsx|jsx|mjs)$/;
const PAGES_PAGE = /(?:^|\/)pages\/(.+)\.(?:tsx|jsx)$/;

/** app/(group)/@slot/orders/[id] → /orders/:id */
function appSegmentsToPath(seg: string): string {
  const parts = seg.split("/").filter((p) => p && !p.startsWith("(") && !p.startsWith("@") && !/^_/.test(p));
  return normalizePath("/" + parts.join("/"));
}
function pagesToPath(seg: string): string {
  const s = seg.replace(/(^|\/)index$/, "");
  return normalizePath("/" + s);
}

function exportedHandlers(sf: ts.SourceFile): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const isExported = (n: ts.Node) => !!(ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && isExported(st) && METHODS.has(st.name.text)) out.push({ name: st.name.text, line: lineOf(sf, st) });
    else if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && METHODS.has(d.name.text)) out.push({ name: d.name.text, line: lineOf(sf, d) });
        else if (ts.isObjectBindingPattern(d.name)) for (const el of d.name.elements) if (ts.isIdentifier(el.name) && METHODS.has(el.name.text)) out.push({ name: el.name.text, line: lineOf(sf, el) });
      }
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) if (METHODS.has(el.name.text)) out.push({ name: el.name.text, line: lineOf(sf, el) });
    }
  }
  return out;
}

/** body keys read in a handler file: `const { a, b } = await req.json()`, `body.email`, `formData.get("x")` */
function bodyKeysOf(text: string): { name: string }[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\{\s*([^{}=]*?)\s*\}\s*=\s*(?:await\s+)?(?:req|request)\.json\(\)/g)) for (const k of m[1].split(",")) { const n = k.split(":")[0].trim().replace(/\s*=.*$/, ""); if (/^\w+$/.test(n)) keys.add(n); }
  const bodyVars = [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:req|request)\.json\(\)/g)].map((m) => m[1]);
  for (const v of ["body", "data", "payload", "json", "input", ...bodyVars]) for (const m of text.matchAll(new RegExp(`\\b${v}\\.(\\w+)`, "g"))) if (bodyVars.includes(v) || /(?:req|request)\.json\(\)/.test(text)) keys.add(m[1]);
  for (const m of text.matchAll(/(?:formData|form|fd)\.get\(\s*["'](\w+)["']\s*\)/g)) keys.add(m[1]);
  return [...keys].filter((k) => !/^(then|catch|map|length|toString)$/.test(k)).map((name) => ({ name }));
}

function authOf(text: string): boolean | "unknown" {
  if (/\b(getServerSession|auth\(\)|currentUser\(|getAuth\(|requireAuth|verifyToken|getToken\(|authenticate|withAuth|getSession\(|jwt\.verify|clerkClient|supabase\.auth\.getUser)/.test(text)) return true;
  return "unknown";
}

interface FieldAcc { label: string; name?: string; uiType: string; required?: boolean; line?: number }
const INPUT_TAGS = new Set(["input", "Input", "TextInput", "TextField", "select", "Select", "textarea", "Textarea", "TextArea", "Checkbox", "Switch", "RadioGroup", "DatePicker", "FormField", "Field"]);

function uiTypeFor(tag: string, type?: string, name?: string): string {
  const t = (type ?? "").toLowerCase();
  if (/^(select|radiogroup)$/i.test(tag)) return "select";
  if (/^textarea$/i.test(tag)) return "textarea";
  if (/^(checkbox|switch)$/i.test(tag)) return "checkbox";
  if (/^datepicker$/i.test(tag)) return "date";
  if (t) {
    if (["email", "password", "number", "date", "checkbox", "hidden", "tel", "file", "url", "radio", "range", "time", "datetime-local"].includes(t)) return t === "radio" ? "select" : t === "datetime-local" ? "date" : t;
    return "text";
  }
  const n = (name ?? "").toLowerCase();
  if (/email/.test(n)) return "email";
  if (/password|passwd/.test(n)) return "password";
  if (/(amount|price|qty|quantity|count|age|zip|cvc|cvv)$/.test(n)) return "number";
  if (/date|dob|birthday/.test(n)) return "date";
  return "text";
}

/** Extract form fields from a JSX file. */
function fieldsOf(sf: ts.SourceFile): FieldAcc[] {
  const labelsFor = new Map<string, string>();
  const fields: FieldAcc[] = [];
  const seen = new Set<string>();
  const jsxText = (el: ts.JsxElement): string =>
    el.children.map((c) => ts.isJsxText(c) ? c.text : ts.isJsxExpression(c) && c.expression && ts.isStringLiteralLike(c.expression) ? c.expression.text : "").join(" ").replace(/\s+/g, " ").trim();
  // pass 1: labels
  walk(sf, (n) => {
    if (ts.isJsxElement(n)) {
      const tag = n.openingElement.tagName.getText(sf);
      if (/^(label|Label|FormLabel)$/.test(tag)) {
        const text = jsxText(n);
        for (const a of n.openingElement.attributes.properties) {
          if (ts.isJsxAttribute(a) && /^(htmlFor|for)$/.test(idName(a.name) ?? "") && a.initializer && ts.isStringLiteral(a.initializer)) labelsFor.set(a.initializer.text, text);
        }
        if (text) labelsFor.set("__enclosing__" + n.pos, text);
      }
    }
  });
  const attrs = (el: ts.JsxOpeningLikeElement) => {
    const out: Record<string, string | true> = {};
    for (const a of el.attributes.properties) {
      if (ts.isJsxAttribute(a)) {
        const k = idName(a.name) ?? "";
        if (!a.initializer) out[k] = true;
        else if (ts.isStringLiteral(a.initializer)) out[k] = a.initializer.text;
        else if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
          const e = a.initializer.expression;
          if (ts.isStringLiteralLike(e)) out[k] = e.text;
          else if (e.kind === ts.SyntaxKind.TrueKeyword) out[k] = true;
        }
      } else if (ts.isJsxSpreadAttribute(a) && ts.isCallExpression(a.expression) && idName(a.expression.expression) === "register") {
        const arg = a.expression.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) { out.name = arg.text; out.__register = true; }
        const opts = a.expression.arguments[1];
        if (opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => idName(p.name) === "required")) out.required = true;
      }
    }
    return out;
  };
  const enclosingLabel = (n: ts.Node): string | undefined => {
    let p = n.parent;
    let depth = 0;
    while (p) {
      if (ts.isJsxElement(p) && /^(label|Label|FormLabel|FormItem|FormField)$/.test(p.openingElement.tagName.getText(sf))) {
        const t = labelsFor.get("__enclosing__" + p.pos);
        if (t) return t;
        // label as a sibling inside FormItem
        for (const c of p.children) if (ts.isJsxElement(c) && /^(label|Label|FormLabel)$/.test(c.openingElement.tagName.getText(sf))) return jsxText(c);
      }
      // `<div><label>URL</label><input …/></div>` — the nearest preceding <label>/<span class="label"> sibling (two levels up max)
      if (ts.isJsxElement(p) && depth < 2) {
        let last: string | undefined;
        for (const c of p.children) {
          if (c.pos >= n.pos) break;
          if (ts.isJsxElement(c)) {
            const tag = c.openingElement.tagName.getText(sf);
            const cls = c.openingElement.attributes.properties.find((a) => ts.isJsxAttribute(a) && idName(a.name) === "className");
            const clsText = cls && ts.isJsxAttribute(cls) && cls.initializer && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : "";
            if (/^(label|Label|FormLabel)$/.test(tag) || /\blabel\b/.test(clsText)) { const t = jsxText(c); if (t) last = t; }
          }
        }
        if (last) return last;
      }
      depth++;
      p = p.parent;
    }
    return undefined;
  };
  const push = (f: FieldAcc) => { const k = (f.name ?? f.label).toLowerCase(); if (!seen.has(k)) { seen.add(k); fields.push(f); } };
  // pass 2: inputs
  walk(sf, (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      if (!INPUT_TAGS.has(tag)) return;
      const a = attrs(n);
      if (a.type === "submit" || a.type === "button") return;
      const name = typeof a.name === "string" ? a.name : typeof a.id === "string" ? a.id : undefined;
      const type = typeof a.type === "string" ? a.type : undefined;
      const label = (typeof a.id === "string" && labelsFor.get(a.id)) || (name && labelsFor.get(name)) || enclosingLabel(n)
        || (typeof a.label === "string" ? a.label : undefined) || (typeof a["aria-label"] === "string" ? a["aria-label"] : undefined)
        || (typeof a.placeholder === "string" ? a.placeholder : undefined) || (name ? humanize(name) : undefined);
      if (!label && !name) return;
      push({ label: label ?? humanize(name!), name, uiType: uiTypeFor(tag, type, name), required: a.required === true || typeof a.required === "string" || undefined, line: lineOf(sf, n) });
    } else if (ts.isCallExpression(n) && idName(n.expression) === "register" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const name = n.arguments[0].text;
      const parentIsSpread = n.parent && ts.isJsxSpreadAttribute(n.parent);
      if (!parentIsSpread) push({ label: labelsFor.get(name) ?? humanize(name), name, uiType: uiTypeFor("input", undefined, name), line: lineOf(sf, n) });
    }
  });
  return fields;
}

/** Local components the file renders, resolved to repo files where possible. */
function componentsOf(sf: ts.SourceFile, rel: string, fileSet: Set<string>): string[] {
  const imp = imports(sf);
  const used = new Set<string>();
  walk(sf, (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const t = n.tagName;
      const root = ts.isIdentifier(t) ? t.text : ts.isPropertyAccessExpression(t) ? (ts.isIdentifier(t.expression) ? t.expression.text : "") : "";
      if (root && imp.has(root)) used.add(root);
    }
  });
  const out = new Set<string>();
  for (const name of used) {
    const i = imp.get(name)!;
    out.add(resolveImport(i.spec, rel, fileSet) ?? i.spec);
  }
  return [...out];
}

function isUseServerFile(text: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(text);
}

export const nextjsExtractor: Extractor = {
  name: "nextjs",
  applies(det, files) {
    return det.frameworks.includes("nextjs") || files.some((f) => APP_ROUTE.test(f.rel) || APP_PAGE.test(f.rel) || PAGES_API.test(f.rel));
  },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const routes: RouteFact[] = [];
    const screens: ScreenFact[] = [];
    const fileSet = fileSetOf(ctx.files);
    const candidates = ctx.files.filter((f) => !isSkipped(f.rel) && f.size <= MAX_FILE_BYTES && /\.(ts|tsx|js|jsx|mjs)$/.test(f.rel) && !isTestFile(f.rel));
    const parsedCache = new Map<string, ts.SourceFile>();
    const parse = async (f: RepoFile | string): Promise<ts.SourceFile | undefined> => {
      const rel = typeof f === "string" ? f : f.rel;
      if (parsedCache.has(rel)) return parsedCache.get(rel);
      const text = await safeRead(ctx, rel);
      if (text === undefined) return undefined;
      const sf = parseTs(rel, text);
      parsedCache.set(rel, sf);
      return sf;
    };

    for (const f of candidates) {
      try {
        const rel = f.rel;
        let m: RegExpExecArray | null;
        if ((m = APP_ROUTE.exec(rel))) {
          const sf = await parse(f); if (!sf) continue;
          const text = sf.text;
          const path = appSegmentsToPath(m[1]);
          for (const h of exportedHandlers(sf)) {
            routes.push({ method: h.name as RouteFact["method"], path, framework: "nextjs-app", file: rel, line: h.line, handlerName: h.name, auth: authOf(text), bodyKeys: h.name === "GET" ? undefined : bodyKeysOf(text), confidence: 1, evidence: [{ kind: "static", file: rel, line: h.line }] });
          }
        } else if ((m = PAGES_API.exec(rel))) {
          const sf = await parse(f); if (!sf) continue;
          const text = sf.text;
          const path = pagesToPath(m[1]);
          const found = new Set<string>();
          for (const mm of text.matchAll(/req\.method\s*(?:===?|!==?)\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/g)) found.add(mm[1]);
          for (const mm of text.matchAll(/case\s+["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]\s*:/g)) found.add(mm[1]);
          for (const mm of text.matchAll(/\.(get|post|put|patch|delete)\(\s*(?:async\s*)?\(?\s*req/g)) found.add(mm[1].toUpperCase()); // next-connect
          const methods = found.size ? [...found] : ["ANY"];
          for (const method of methods) routes.push({ method: method as RouteFact["method"], path, framework: "nextjs-pages", file: rel, line: 1, auth: authOf(text), bodyKeys: method === "GET" ? undefined : bodyKeysOf(text), confidence: found.size ? 1 : 0.8, evidence: [{ kind: "static", file: rel, line: 1 }] });
        } else if ((m = APP_PAGE.exec(rel))) {
          const sf = await parse(f); if (!sf) continue;
          const path = appSegmentsToPath(m[1]);
          const components = componentsOf(sf, rel, fileSet);
          const fields = fieldsOf(sf);
          // fields declared inside directly-used local components count for this screen
          for (const c of components) if (fileSet.has(c)) { const csf = await parse(c); if (csf) for (const fld of fieldsOf(csf)) if (!fields.some((x) => (x.name ?? x.label) === (fld.name ?? fld.label))) fields.push(fld); }
          screens.push({ path, name: path === "/" ? "Home" : humanize(basename(path)), file: rel, kind: "page", fields, componentsUsed: components });
        } else if ((m = PAGES_PAGE.exec(rel)) && !/^api\//.test(m[1]) && !/^(_app|_document|_error)$/.test(m[1])) {
          const sf = await parse(f); if (!sf) continue;
          const path = pagesToPath(m[1]);
          const components = componentsOf(sf, rel, fileSet);
          const fields = fieldsOf(sf);
          for (const c of components) if (fileSet.has(c)) { const csf = await parse(c); if (csf) for (const fld of fieldsOf(csf)) if (!fields.some((x) => (x.name ?? x.label) === (fld.name ?? fld.label))) fields.push(fld); }
          screens.push({ path, name: path === "/" ? "Home" : humanize(basename(path)), file: rel, kind: "page", fields, componentsUsed: components });
        }
        // server actions (any file with a top-level "use server" directive)
        if (/\.(ts|tsx|js|jsx)$/.test(rel) && !APP_ROUTE.test(rel)) {
          const sf = await parse(f); if (!sf) continue;
          if (!isUseServerFile(sf.text)) continue;
          for (const st of sf.statements) {
            const exported = !!(ts.getCombinedModifierFlags(st as unknown as ts.Declaration) & ts.ModifierFlags.Export);
            if (!exported) continue;
            const add = (name: string, node: ts.Node) => {
              const body = node.getText(sf);
              routes.push({ method: "POST", path: `/_action/${name}`, framework: "server-action", file: rel, line: lineOf(sf, node), handlerName: name, auth: authOf(body), bodyKeys: bodyKeysOf(body), confidence: 1, evidence: [{ kind: "static", file: rel, line: lineOf(sf, node), note: "use server" }] });
            };
            if (ts.isFunctionDeclaration(st) && st.name) add(st.name.text, st);
            else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) add(d.name.text, d);
          }
        }
      } catch (e) {
        ctx.log(`nextjs: failed on ${f.rel}: ${(e as Error).message}`, "warn");
      }
    }
    // inline "use server" functions inside non-directive files
    for (const [rel, sf] of parsedCache) {
      if (isUseServerFile(sf.text)) continue;
      try {
        walk(sf, (n) => {
          if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
            const first = n.body.statements[0];
            if (first && ts.isExpressionStatement(first) && ts.isStringLiteralLike(first.expression) && first.expression.text === "use server") {
              const name = (ts.isFunctionDeclaration(n) && n.name?.text) || (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : undefined);
              if (name) routes.push({ method: "POST", path: `/_action/${name}`, framework: "server-action", file: rel, line: lineOf(sf, n), handlerName: name, auth: authOf(n.getText(sf)), bodyKeys: bodyKeysOf(n.getText(sf)), confidence: 1, evidence: [{ kind: "static", file: rel, line: lineOf(sf, n), note: "inline use server" }] });
            }
          }
        });
      } catch { /* ignore */ }
    }
    ctx.log(`nextjs: ${routes.length} routes, ${screens.length} screens`);
    return { routes, screens };
  },
};

export { fieldsOf as extractJsxFields, componentsOf as extractComponentsUsed };
