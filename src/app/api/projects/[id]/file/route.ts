// Read + write a single source file inside the project's folder, for the in-app code editor.
// Path-safe like the source route: resolve inside rootPath, refuse secret files, binaries, and big files.
// PUT is optimistic-concurrency (baseHash), atomic (temp + rename), and preserves the file's line endings;
// `baseHash: null` creates a NEW file (409 if one already exists). The logic lives in lib/arkus/filewrite.ts.
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import fs from "node:fs/promises";
import { EDIT_MAX_FILE_BYTES, languageFromPath } from "@/lib/arkus/fs";
import { FileWriteError, resolveInside, sha1, writeProjectFile } from "@/lib/arkus/filewrite";
import { bad, ok, readJson } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

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
  const body = await readJson<{ path?: string; content?: string; baseHash?: string | null }>(req);
  if (typeof body.content !== "string") return bad("Missing content", 400);
  // `baseHash: null` = create a new file; a missing / empty baseHash is still refused (the editor always has one).
  if (body.baseHash !== null && !body.baseHash) return bad("Missing baseHash", 400);
  try {
    const r = await writeProjectFile({ id: p.id, rootPath: p.rootPath }, { path: body.path || "", content: body.content, baseHash: body.baseHash });
    return ok({ ok: true, hash: r.hash, bytes: r.bytes, lines: r.lines, created: r.created, ...(r.unchanged ? { unchanged: true } : {}) });
  } catch (e) {
    if (e instanceof FileWriteError) return ok({ error: e.message, ...e.extra }, { status: e.status });
    return bad((e as Error).message || "Could not write file", 500);
  }
}
