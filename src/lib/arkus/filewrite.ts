// Write one source file inside the project folder: the logic behind PUT /api/projects/[id]/file, shared
// with AI actions (apply write_file). Path-safe (resolved inside rootPath), refuses secret / binary files,
// optimistic concurrency via baseHash for existing files, `baseHash: null` creates a new file, atomic
// temp + rename, keeps the original's line endings, and leaves an Activity "code" row.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { BINARY_EXT, EDIT_MAX_FILE_BYTES, SECRET_FILE_RE } from "./fs";

export const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

export type Resolved = { root: string; abs: string; rel: string };
/** Normalise + resolve a relative path inside the project root, or return a refusal reason. */
export function resolveInside(rootPath: string, raw: string): Resolved | { error: string; status: number } {
  const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return { error: "Missing path", status: 400 };
  const root = path.resolve(rootPath);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return { error: "Path is outside the project folder", status: 403 };
  if (SECRET_FILE_RE.test(rel)) return { error: "Secret files cannot be opened in Arkus", status: 403 };
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return { error: "Binary files cannot be edited in Arkus", status: 403 };
  return { root, abs, rel };
}

export class FileWriteError extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

export type WriteResult = { ok: true; path: string; hash: string; bytes: number; lines: { added: number; removed: number }; created: boolean; unchanged?: boolean };

/** Current content + hash of a file, or null when it does not exist. */
export async function readCurrent(abs: string): Promise<{ content: string; hash: string } | null> {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new FileWriteError("Not a file", 404);
    const content = await fs.readFile(abs, "utf8");
    return { content, hash: sha1(content) };
  } catch (e) {
    if (e instanceof FileWriteError) throw e;
    return null;
  }
}

/**
 * Write `content` to `rel` inside the project. `baseHash` must match the file on disk (409 otherwise);
 * `baseHash: null` means "create": refused (409) when the file already exists.
 */
export async function writeProjectFile(project: { id: string; rootPath: string }, input: { path: string; content: string; baseHash: string | null }): Promise<WriteResult> {
  if (typeof input.content !== "string") throw new FileWriteError("Missing content");
  if (Buffer.byteLength(input.content, "utf8") > EDIT_MAX_FILE_BYTES) throw new FileWriteError(`Content is larger than ${Math.round(EDIT_MAX_FILE_BYTES / 1024)} KB`, 413);
  const r = resolveInside(project.rootPath, input.path || "");
  if ("error" in r) throw new FileWriteError(r.error, r.status);

  const current = await readCurrent(r.abs);
  if (input.baseHash === null) {
    if (current) throw new FileWriteError("File already exists", 409, { hash: current.hash });
  } else {
    if (!current) throw new FileWriteError("File not found", 404);
    if (current.hash !== input.baseHash) throw new FileWriteError("File changed on disk since you opened it", 409, { hash: current.hash });
  }
  const original = current?.content ?? "";
  // Match the original's line endings (CRLF if it used any, else LF).
  const crlf = /\r\n/.test(original);
  const next = input.content.replace(/\r\n/g, "\n").replace(/\n/g, crlf ? "\r\n" : "\n");
  if (current && next === original) return { ok: true, path: r.rel, hash: current.hash, bytes: Buffer.byteLength(original, "utf8"), lines: { added: 0, removed: 0 }, created: false, unchanged: true };

  // Atomic write: temp file in the same dir, then rename over the target.
  await fs.mkdir(path.dirname(r.abs), { recursive: true });
  const tmp = path.join(path.dirname(r.abs), `.${path.basename(r.abs)}.arkus-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, r.abs);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* already gone */ }
    throw new FileWriteError(`Could not write file: ${(e as Error).message}`, 500);
  }

  const lines = current ? lineDelta(original, next) : { added: next.split(/\r?\n/).length, removed: 0 };
  const bytes = Buffer.byteLength(next, "utf8");
  const what = current ? `Edited ${r.rel} (+${lines.added} −${lines.removed} lines)` : `Created ${r.rel} (${lines.added} lines)`;
  await Promise.all([
    prisma.activity.create({ data: { projectId: project.id, kind: "code", what, meta: JSON.stringify({ path: r.rel, bytes, lines, created: !current, reindex: true }) } }),
    prisma.setting.upsert({ where: { key: `project.${project.id}.codeDirty` }, create: { key: `project.${project.id}.codeDirty`, value: "1" }, update: { value: "1" } }),
  ]);
  return { ok: true, path: r.rel, hash: sha1(next), bytes, lines, created: !current };
}

/** Cheap added/removed line counts via LCS on line arrays (files are <= 1 MB, so O(n*m) with a cap is fine). */
export function lineDelta(a: string, b: string): { added: number; removed: number } {
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
