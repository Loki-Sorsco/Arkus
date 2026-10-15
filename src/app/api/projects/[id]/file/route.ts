// Read + write a single source file inside the project's folder, for the in-app code editor.
// Path-safe like the source route: resolve inside rootPath, refuse secret files, binaries, and big files.
// PUT is optimistic-concurrency (baseHash), atomic (temp + rename), and preserves the file's line endings.
import { createHash } from "node:crypto";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { BINARY_EXT, EDIT_MAX_FILE_BYTES, languageFromPath, SECRET_FILE_RE } from "@/lib/arkus/fs";
import { bad, ok, readJson } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

type Resolved = { root: string; abs: string; rel: string };
/** Normalise + resolve a relative path inside the project root, or return a refusal reason. */
function resolveInside(rootPath: string, raw: string): Resolved | { error: string; status: number } {
  const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return { error: "Missing path", status: 400 };
  const root = path.resolve(rootPath);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return { error: "Path is outside the project folder", status: 403 };
  if (SECRET_FILE_RE.test(rel)) return { error: "Secret files cannot be opened in Arkus", status: 403 };
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return { error: "Binary files cannot be edited in Arkus", status: 403 };
  return { root, abs, rel };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p || !p.rootPath) return bad("Not found", 404);
  const r = resolveInside(p.rootPath, new URL(req.url).searchParams.get("path") || "");
  if ("error" in r) return bad(r.error, r.status);
  let st;
  try { st = await fs.stat(r.abs); } catch { return bad("File not found", 404); }
  if (!st.isFile()) return bad("Not a file", 404);
  if (st.size > EDIT_MAX_FILE_BYTES) return bad(`File is larger than ${Math.round(EDIT_MAX_FILE_BYTES / 1024)} KB`, 413);
  const content = await fs.readFile(r.abs, "utf8");
  return ok({ path: r.rel, content, hash: sha1(content), size: st.size, language: languageFromPath(r.rel), readOnly: false });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p || !p.rootPath) return bad("Not found", 404);
  const body = await readJson<{ path?: string; content?: string; baseHash?: string }>(req);
  if (typeof body.content !== "string") return bad("Missing content", 400);
  if (!body.baseHash) return bad("Missing baseHash", 400);
  if (Buffer.byteLength(body.content, "utf8") > EDIT_MAX_FILE_BYTES) return bad(`Content is larger than ${Math.round(EDIT_MAX_FILE_BYTES / 1024)} KB`, 413);
  const r = resolveInside(p.rootPath, body.path || "");
  if ("error" in r) return bad(r.error, r.status);

  // Never create files in this iteration: the target must already exist.
  let original: string;
  try {
    const st = await fs.stat(r.abs);
    if (!st.isFile()) return bad("Not a file", 404);
    original = await fs.readFile(r.abs, "utf8");
  } catch { return bad("File not found", 404); }
  const currentHash = sha1(original);
  if (currentHash !== body.baseHash) return ok({ error: "File changed on disk since you opened it", hash: currentHash }, { status: 409 });

  // Match the original's line endings (CRLF if it used any, else LF).
  const crlf = /\r\n/.test(original);
  const next = body.content.replace(/\r\n/g, "\n").replace(/\n/g, crlf ? "\r\n" : "\n");
  if (next === original) return ok({ ok: true, hash: currentHash, bytes: Buffer.byteLength(original, "utf8"), unchanged: true });

  // Atomic write: temp file in the same dir, then rename over the target.
  const tmp = path.join(path.dirname(r.abs), `.${path.basename(r.abs)}.arkus-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, r.abs);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* already gone */ }
    return bad(`Could not write file: ${(e as Error).message}`, 500);
  }

  const lines = lineDelta(original, next);
  const bytes = Buffer.byteLength(next, "utf8");
  const sign = (n: number, s: string) => `${s}${n}`;
  await Promise.all([
    prisma.activity.create({ data: { projectId: p.id, kind: "code", what: `Edited ${r.rel} (${sign(lines.added, "+")} ${sign(lines.removed, "−")} lines)`, meta: JSON.stringify({ path: r.rel, bytes, lines, reindex: true }) } }),
    prisma.setting.upsert({ where: { key: `project.${p.id}.codeDirty` }, create: { key: `project.${p.id}.codeDirty`, value: "1" }, update: { value: "1" } }),
  ]);
  return ok({ ok: true, hash: sha1(next), bytes, lines });
}

/** Cheap added/removed line counts via LCS on line arrays (files are <= 1 MB, so O(n*m) with a cap is fine). */
function lineDelta(a: string, b: string): { added: number; removed: number } {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  // Trim common prefix/suffix first so the quadratic part only covers the changed window.
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const X = A.slice(s, A.length - e), Y = B.slice(s, B.length - e);
  if (!X.length || !Y.length || X.length * Y.length > 4_000_000) return { added: Y.length, removed: X.length };
  let prev = new Uint32Array(Y.length + 1);
  for (let i = 1; i <= X.length; i++) {
    const cur = new Uint32Array(Y.length + 1);
    for (let j = 1; j <= Y.length; j++) cur[j] = X[i - 1] === Y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const common = prev[Y.length];
  return { added: Y.length - common, removed: X.length - common };
}
