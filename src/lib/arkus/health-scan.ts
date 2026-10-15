// Health: the light file scan. Reads a bounded set of source files (handlers, pages, then the rest
// of the repo up to a cap) and runs plain regex checks. Nothing here keeps file contents: only
// file, line and a label leave this module, so a secret value can never end up in a report.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { SECRET_FILE_RE, SKIP_DIRS, walkRepo } from "./fs";

export const SCAN_MAX_FILES = 400;
export const SCAN_MAX_BYTES = 200 * 1024;
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".py", ".rb", ".php", ".go"]);

export type ScannedFile = { rel: string; text: string; lines: string[] };
export type Finding = { kind: string; file: string; line: number; detail?: string };

const skipRe = new RegExp(`(^|/)(${SKIP_DIRS.map((d) => d.replace(/\./g, "\\.")).join("|")})/`);
export const isScannable = (rel: string) => !skipRe.test(rel) && !SECRET_FILE_RE.test(rel) && CODE_EXT.has(path.extname(rel).toLowerCase());

/** Read up to SCAN_MAX_FILES source files: `priority` first (files the graph points at), then the rest of the repo. */
export async function scanFiles(root: string, priority: string[]): Promise<Map<string, ScannedFile>> {
  const out = new Map<string, ScannedFile>();
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const rel of priority) { const r = rel.replace(/\\/g, "/"); if (!seen.has(r) && isScannable(r)) { seen.add(r); wanted.push(r); } }
  if (wanted.length < SCAN_MAX_FILES) {
    try {
      const { files } = await walkRepo(root);
      for (const f of files) { if (wanted.length >= SCAN_MAX_FILES) break; if (!seen.has(f.rel) && isScannable(f.rel) && f.size <= SCAN_MAX_BYTES) { seen.add(f.rel); wanted.push(f.rel); } }
    } catch { /* unreadable root: scan only what the graph names */ }
  }
  await Promise.all(wanted.slice(0, SCAN_MAX_FILES).map(async (rel) => {
    try {
      const abs = path.join(root, rel);
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > SCAN_MAX_BYTES) return;
      const text = await fs.readFile(abs, "utf8");
      out.set(rel, { rel, text, lines: text.split(/\r?\n/) });
    } catch { /* missing or unreadable: skip */ }
  }));
  return out;
}

// ---------- line-level patterns ----------
type Rule = { kind: string; re: RegExp; skip?: RegExp; detail: string };
const SECRET_RULES: Rule[] = [
  { kind: "secret", re: /\bsk-[A-Za-z0-9_-]{20,}/, detail: "a key that looks like an OpenAI or Anthropic API key" },
  { kind: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, detail: "a key that looks like a GitHub token" },
  { kind: "secret", re: /\bAKIA[0-9A-Z]{16}\b/, detail: "a key that looks like an AWS access key" },
  { kind: "secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, detail: "a private key block" },
  { kind: "secret", re: /\bpassword\s*=\s*["'][^"'\n]{4,}["']/i, skip: /process\.env|placeholder|example|\.\.\./i, detail: "a password written directly in the code" },
];
const CODE_RULES: Rule[] = [
  { kind: "sql_concat", re: /["'`][^"'`\n]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'`\n]*(\$\{|["']\s*\+\s*[A-Za-z_])/i, skip: /\$queryRaw`|\$executeRaw`|\bsql`|Prisma\.sql`|\/\/|\/\*|^\s*\*/, detail: "SQL text built from variables" },
  { kind: "eval", re: /\beval\s*\(|\bnew\s+Function\s*\(/, skip: /\/\/|\/\*|^\s*\*|safeEval|["'].*\beval\b.*["']/, detail: "eval or new Function" },
  { kind: "cors_any", re: /Access-Control-Allow-Origin["']?\s*[:,=]\s*["']\*|\bcors\(\s*\)/, detail: "any website may call this server" },
  { kind: "dangerous_html", re: /dangerouslySetInnerHTML/, detail: "raw HTML injected into the page" },
  { kind: "env_fallback", re: /process\.env\.[A-Za-z0-9_]*(SECRET|KEY|TOKEN|PASSWORD|PASS|JWT|SALT)[A-Za-z0-9_]*\s*(\|\||\?\?)\s*["'`][^"'`\n]{4,}["'`]/, skip: /NEXT_PUBLIC_|PUBLIC_KEY|localhost|http/, detail: "a secret with a hard-coded fallback value" },
];

/** Run the security rules over one file. Returns file/line/label only. */
export function scanSecurity(f: ScannedFile): Finding[] {
  const out: Finding[] = [];
  const sanitised = /sanitize|DOMPurify|purify/i.test(f.text);
  f.lines.forEach((ln, i) => {
    if (ln.length > 2000) return;
    for (const r of [...SECRET_RULES, ...CODE_RULES]) {
      if (!r.re.test(ln) || (r.skip && r.skip.test(ln))) continue;
      if (r.kind === "dangerous_html" && sanitised) continue;
      out.push({ kind: r.kind, file: f.rel, line: i + 1, detail: r.detail });
    }
  });
  return out;
}

export const countMatches = (text: string, re: RegExp) => (text.match(re) || []).length;
export const hasTryCatch = (text: string) => /\btry\s*\{/.test(text) || /\.catch\s*\(/.test(text);
export const hasValidation = (text: string) => /\b(zod|joi|yup|valibot|superstruct|class-validator)\b/i.test(text) || /\.(parse|safeParse|parseAsync|validate|validateSync|assert)\s*\(/.test(text);
export const hasErrorHandling = (text: string) => /\bcatch\b|\berror\b|\bloading\b|isLoading|isPending|Suspense|\berror\.tsx|\bloading\.tsx/i.test(text);
/** Does the handler read a request body at all? (No body: nothing to validate.) */
export const readsBody = (text: string) => /\.(json|formData|text|arrayBuffer)\s*\(\s*\)|readBody|\b(req|request)\.body\b|parseBody/.test(text);
export const isClientComponent = (text: string) => /^\s*["']use client["']/m.test(text);
export const consoleLogs = (text: string) => countMatches(text, /\bconsole\.log\s*\(/g);
export const anyTypes = (text: string) => countMatches(text, /:\s*any\b|\bas\s+any\b|<any>/g);

/** `export const GET = withAuth(async ...)` → "withAuth"; null when the handler is a plain function. */
export function wrapperOf(slice: string): string | null {
  const m = /export\s+(?:const|let)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|handler|default)\s*=\s*([A-Za-z_$][\w$.]*)\s*(?:<[^()]*>)?\s*\(/.exec(slice);
  return m && !/^(async|function)$/.test(m[1]) ? m[1] : null;
}
/** Follow `import { name } from "spec"` in `fromFile` to a scanned file (`@/` → src/, relative paths). */
export function resolveImport(files: Map<string, ScannedFile>, fromFile: string, name: string): ScannedFile | undefined {
  const f = files.get(fromFile); if (!f) return undefined;
  const base = name.split(".")[0];
  const m = new RegExp(`import\\s+(?:[^;]*?\\b${base}\\b[^;]*?)\\s+from\\s+["']([^"']+)["']`).exec(f.text);
  if (!m) return undefined;
  const spec = m[1];
  let rel: string;
  if (spec.startsWith("@/") || spec.startsWith("~/")) rel = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  else return undefined; // a package: cannot see inside
  for (const ext of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"]) { const hit = files.get(rel + ext); if (hit) return hit; }
  return undefined;
}
/** Next.js app router: an error.tsx or loading.tsx in the page's folder or any folder above it (inside app/). */
export function segmentHandled(files: Map<string, ScannedFile>, pageFile: string): boolean {
  let dir = path.posix.dirname(pageFile);
  for (let i = 0; i < 12 && dir && dir !== "."; i++) {
    for (const n of ["error.tsx", "error.jsx", "loading.tsx", "loading.jsx", "global-error.tsx"]) if (files.has(`${dir}/${n}`)) return true;
    if (/(^|\/)(app|pages)$/.test(dir)) break;
    dir = path.posix.dirname(dir);
  }
  return false;
}

/** Slice of a handler: from its start line to the next route in the same file (or the end). */
export function handlerSlice(f: ScannedFile, start: number | undefined, end: number | undefined, nextStarts: number[]): { text: string; lines: number } {
  if (!start) return { text: f.text, lines: f.lines.length };
  const after = nextStarts.filter((n) => n > start).sort((a, b) => a - b)[0];
  const stop = end && end >= start ? end : after ? after - 1 : f.lines.length;
  const seg = f.lines.slice(start - 1, stop);
  return { text: seg.join("\n"), lines: seg.length };
}

// ---------- npm audit ----------
export type AuditSummary = { critical: number; high: number; moderate: number; low: number; info: number; total: number } | null;

/** `npm audit --json --omit=dev` summary, or null when there is no lockfile or npm could not run. */
export async function npmAudit(root: string): Promise<AuditSummary> {
  try { await fs.access(path.join(root, "package-lock.json")); } catch { return null; }
  const stdout = await new Promise<string>((resolve) => {
    const win = process.platform === "win32";
    const child = execFile(win ? "npm.cmd" : "npm", ["audit", "--json", "--omit=dev"], { cwd: root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, shell: win, windowsHide: true }, (err, out) => {
      // npm exits 1 when it finds vulnerabilities; the JSON is still on stdout.
      resolve(typeof out === "string" ? out : String(out ?? ""));
      void err;
    });
    child.on("error", () => resolve(""));
  });
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const j = JSON.parse(stdout.slice(start)) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const v = j.metadata?.vulnerabilities;
    if (!v) return null;
    const n = (k: string) => Number(v[k] || 0);
    return { critical: n("critical"), high: n("high"), moderate: n("moderate"), low: n("low"), info: n("info"), total: n("total") || n("critical") + n("high") + n("moderate") + n("low") + n("info") };
  } catch { return null; }
}
