// Shared helpers for the static extractors. No user code is ever executed here.
import ts from "typescript";
import type { ExtractContext, RepoFile } from "../types";

export const MAX_FILE_BYTES = 512 * 1024;
const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const SKIP_DIR = /(^|\/)(node_modules|\.next|\.nuxt|dist|build|out|coverage|\.git|\.turbo|vendor|__pycache__|\.venv|venv)\//;

export function extOf(rel: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(rel);
  return m ? m[1].toLowerCase() : "";
}
export function isCodeFile(f: RepoFile): boolean {
  return CODE_EXT.has(extOf(f.rel)) && !SKIP_DIR.test(f.rel) && f.size <= MAX_FILE_BYTES;
}
export function isSkipped(rel: string): boolean {
  return SKIP_DIR.test(rel);
}
export function isTestFile(rel: string): boolean {
  return /(\.(test|spec|stories)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__|tests?)\//.test(rel);
}

export function parseTs(rel: string, text: string): ts.SourceFile {
  const ext = extOf(rel);
  const kind = ext === "tsx" ? ts.ScriptKind.TSX : ext === "jsx" ? ts.ScriptKind.JSX
    : ext.endsWith("js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
export function lineOfOffset(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Depth-first walk; return false from visitor to skip children. */
export function walk(node: ts.Node, visit: (n: ts.Node) => void | false): void {
  if (visit(node) === false) return;
  node.forEachChild((c) => walk(c, visit));
}

export function idName(n: ts.Node | undefined): string | undefined {
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  return undefined;
}

/** Full dotted receiver text for `a.b.c` → "a.b.c" (undefined if not a plain chain). */
export function dotted(n: ts.Node): string | undefined {
  if (ts.isIdentifier(n)) return n.text;
  if (n.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(n)) {
    const l = dotted(n.expression);
    return l ? `${l}.${n.name.text}` : undefined;
  }
  if (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return dotted(n.expression);
  return undefined;
}

export interface StrValue { text: string; dynamic: boolean; head?: string }
const ENV_PREFIX = /^\$\{\s*(process\.env\.\w+|import\.meta\.env\.\w+|env\.\w+|[A-Z_][A-Z0-9_]*|config\.\w+|\w*(?:base|api|url|host|origin)\w*)\s*\}/i;

/** String-ish expression → text with `${…}` replaced by `:param`. Returns undefined if not stringy. */
export function strValue(n: ts.Node | undefined, sf?: ts.SourceFile): StrValue | undefined {
  if (!n) return undefined;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return { text: n.text, dynamic: false };
  if (ts.isTemplateExpression(n)) {
    let out = n.head.text;
    let head = "";
    n.templateSpans.forEach((span, i) => {
      const expr = span.expression.getText(sf);
      const ph = "${" + expr + "}";
      if (i === 0 && out === "") head = ph; else out += ph;
      out += span.literal.text;
    });
    if (head && !ENV_PREFIX.test(head) && !/\/$/.test(n.templateSpans[0].literal.text) && !n.templateSpans[0].literal.text.startsWith("/")) {
      out = head + out; // `${something}` not a base-url prefix: keep as :param
    }
    return { text: out.replace(/\$\{[^}]*\}/g, ":param"), dynamic: true, head };
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = strValue(n.left, sf), r = strValue(n.right, sf);
    if (l || r) {
      const lt = l ? l.text : ":param", rt = r ? r.text : ":param";
      const text = !l && rt.startsWith("/") ? rt : lt + rt;
      return { text, dynamic: true };
    }
    return undefined;
  }
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) return strValue(n.expression, sf);
  if (ts.isConditionalExpression(n)) return strValue(n.whenTrue, sf);
  return undefined;
}

/** Property names of an object literal (incl. shorthand & spread-free). */
export function objectKeys(n: ts.Node | undefined): string[] {
  if (!n || !ts.isObjectLiteralExpression(n)) return [];
  const keys: string[] = [];
  for (const p of n.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
      const k = idName(p.name);
      if (k) keys.push(k);
    }
  }
  return keys;
}

export function getProp(n: ts.Node | undefined, name: string): ts.Expression | undefined {
  if (!n || !ts.isObjectLiteralExpression(n)) return undefined;
  for (const p of n.properties) {
    if (ts.isPropertyAssignment(p) && idName(p.name) === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** Find `const <name> = <init>` anywhere in the file (first match). */
export function findVarInit(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  walk(sf, (n) => {
    if (found) return false;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
  });
  return found;
}

/** Resolve import `spec` from `fromRel` against repo files; returns rel path or undefined. */
export function resolveImport(spec: string, fromRel: string, fileSet: Set<string>): string | undefined {
  let base: string;
  if (spec.startsWith(".")) base = joinPosix(dirname(fromRel), spec);
  else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const r = spec.slice(2);
    const root = fromRel.includes("/src/") ? fromRel.slice(0, fromRel.indexOf("/src/") + 5) : fromRel.startsWith("src/") ? "src/" : "";
    base = root + r;
    if (!tryResolve(base, fileSet)) base = "src/" + r;
  } else return undefined;
  return tryResolve(base, fileSet);
}
function tryResolve(base: string, fileSet: Set<string>): string | undefined {
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/__init__.py"];
  for (const e of exts) if (fileSet.has(base + e)) return base + e;
  return undefined;
}
export function dirname(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
export function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }
export function joinPosix(dir: string, rel: string): string {
  const parts = (dir ? dir.split("/") : []).filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
}

/** Import map for a parsed file: localName → { spec, names } */
export interface ImportInfo { spec: string; imported: string; isDefault: boolean; isNamespace: boolean }
export function imports(sf: ts.SourceFile): Map<string, ImportInfo> {
  const m = new Map<string, ImportInfo>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (!c) continue;
      if (c.name) m.set(c.name.text, { spec, imported: "default", isDefault: true, isNamespace: false });
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) m.set(c.namedBindings.name.text, { spec, imported: "*", isDefault: false, isNamespace: true });
        else for (const el of c.namedBindings.elements) m.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text, isDefault: false, isNamespace: false });
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) {
          const spec = init.arguments[0].text;
          if (ts.isIdentifier(d.name)) m.set(d.name.text, { spec, imported: "default", isDefault: true, isNamespace: true });
          else if (ts.isObjectBindingPattern(d.name)) for (const el of d.name.elements) if (ts.isIdentifier(el.name)) m.set(el.name.text, { spec, imported: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text), isDefault: false, isNamespace: false });
        }
      }
    }
  }
  return m;
}

export function humanize(name: string): string {
  return name.replace(/[_\-.\[\]]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim()
    .split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function safeRead(ctx: ExtractContext, rel: string): Promise<string | undefined> {
  try { return await ctx.read(rel); } catch (e) { ctx.log(`read failed ${rel}: ${(e as Error).message}`, "warn"); return undefined; }
}

export function fileSetOf(files: RepoFile[]): Set<string> { return new Set(files.map((f) => f.rel)); }

export const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "all"] as const;
export function toMethod(v: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY" {
  const u = v.toUpperCase();
  if (u === "ALL" || u === "ANY" || u === "USE") return "ANY";
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(u)) return u as "GET";
  return "ANY";
}
