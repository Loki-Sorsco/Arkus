// Repo walker. Respects .gitignore + .arkusignore, skips vendored/build dirs, binaries, big files,
// and never reads secret files. Returned content is scrubbed of secret-looking values.
import fg from "fast-glob";
import ignore from "ignore";
import fs from "node:fs/promises";
import path from "node:path";
import type { RepoFile } from "./types";

export const SKIP_DIRS = [
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "coverage", ".turbo",
  ".cache", ".venv", "venv", "__pycache__", ".pytest_cache", "vendor", "target", ".idea", ".vscode",
  "storybook-static", ".expo", "android", "ios", ".dart_tool", "Pods", ".scratch",
];
export const SECRET_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|.*\.keystore|secrets?\.(json|ya?ml|toml))$/i;
export const BINARY_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp",".ico",".svg",".pdf",".zip",".gz",".tar",".woff",".woff2",".ttf",".otf",".eot",".mp4",".mp3",".wav",".mov",".heic",".exe",".dll",".so",".dylib",".db",".sqlite",".sqlite3",".lock",".map",".wasm",".jar",".class",".pyc"]);
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES = 20000;

export async function walkRepo(root: string): Promise<{ files: RepoFile[]; skipped: number; secretFiles: string[] }> {
  const ig = ignore();
  for (const name of [".gitignore", ".arkusignore"]) {
    try { ig.add(await fs.readFile(path.join(root, name), "utf8")); } catch { /* none */ }
  }
  const entries = await fg("**/*", {
    cwd: root, dot: false, onlyFiles: true, followSymbolicLinks: false, suppressErrors: true,
    ignore: SKIP_DIRS.map((d) => `**/${d}/**`),
    stats: true,
  });
  const files: RepoFile[] = [];
  const secretFiles: string[] = [];
  let skipped = 0;
  for (const e of entries) {
    const rel = e.path.replace(/\\/g, "/");
    if (ig.ignores(rel)) { skipped++; continue; }
    if (SECRET_FILE_RE.test(rel)) { secretFiles.push(rel); skipped++; continue; }
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) { skipped++; continue; }
    const size = e.stats?.size ?? 0;
    if (size > MAX_FILE_BYTES) { skipped++; continue; }
    files.push({ rel, abs: path.join(root, rel), size, ext });
    if (files.length >= MAX_FILES) break;
  }
  return { files, skipped, secretFiles };
}

// Secret scrub: redact values that look like credentials before anything reaches an LLM or the UI.
const SECRET_PATTERNS: RegExp[] = [
  /(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g,                         // stripe-like
  /gsk_[A-Za-z0-9]{20,}/g,                                              // groq
  /sk-[A-Za-z0-9_-]{20,}/g,                                             // openai/anthropic-like
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                                        // github tokens
  /AKIA[0-9A-Z]{16}/g,                                                  // aws access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                                      // slack
  /AIza[0-9A-Za-z_-]{30,}/g,                                            // google api key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s'"`]+:[^\s'"`@]+@/gi, // creds in urls
  /(["']?(api[_-]?key|secret|password|passwd|token|auth)["']?\s*[:=]\s*["'])([^"'\n]{8,})(["'])/gi,
];
export function scrubSecrets(text: string): { text: string; found: number } {
  let found = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, ...g) => {
      found++;
      if (re.source.startsWith("([\"']?(api")) return `${g[0]}[REDACTED]${g[3]}`;
      if (re.source.startsWith("(postgres")) return m.replace(/:\/\/[^@]+@/, "://[REDACTED]@");
      return "[REDACTED]";
    });
  }
  return { text: out, found };
}

export function makeReader(root: string) {
  const cache = new Map<string, Promise<string>>();
  let secretsFound = 0;
  const read = (rel: string) => {
    let p = cache.get(rel);
    if (!p) {
      p = fs.readFile(path.join(root, rel), "utf8").then((t) => {
        const r = scrubSecrets(t);
        secretsFound += r.found;
        return r.text;
      });
      cache.set(rel, p);
    }
    return p;
  };
  return { read, secretsFound: () => secretsFound };
}

/** List immediate sub-directories (for the local folder picker). Never lists hidden dirs. */
export async function listDirs(dir: string): Promise<{ path: string; name: string; isProject: boolean }[]> {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    let isProject = false;
    for (const marker of ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "composer.json", "Gemfile"]) {
      try { await fs.access(path.join(p, marker)); isProject = true; break; } catch { /* no */ }
    }
    out.push({ path: p, name: e.name, isProject });
  }
  return out.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name));
}

// ---------- Code editing (GET/PUT /api/projects/[id]/file) ----------
/** Largest file the in-app editor will open. Bigger than MAX_FILE_BYTES (the indexer limit) on purpose. */
export const EDIT_MAX_FILE_BYTES = 1024 * 1024;

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
  ".json": "json", ".jsonc": "json", ".css": "css", ".scss": "css", ".md": "markdown", ".mdx": "markdown",
  ".prisma": "prisma", ".sql": "sql", ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
  ".html": "html", ".htm": "html", ".vue": "html", ".svelte": "html", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
  ".sh": "shell", ".bash": "shell", ".ps1": "powershell", ".env.example": "dotenv", ".graphql": "graphql", ".gql": "graphql",
  ".xml": "xml", ".txt": "text",
};
/** Editor language id from a file path (by extension). Unknown extensions map to "text". */
export function languageFromPath(rel: string): string {
  const base = rel.split("/").pop() || rel;
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const i = lower.lastIndexOf(".");
  return (i >= 0 ? LANG_BY_EXT[lower.slice(i)] : undefined) || "text";
}
