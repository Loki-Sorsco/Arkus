// GET ?dir=<rel> → { dir, entries: [{ name, path, kind: "dir"|"file", size?, secret?, binary? }] }
// Path-safe (inside rootPath), skips build/dependency folders, flags secret and binary files (never read).
import fs from "node:fs/promises";
import path from "node:path";
import { BINARY_EXT, SECRET_FILE_RE, SKIP_DIRS } from "@/lib/arkus/fs";
import { bad, ok } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p || !p.rootPath) return bad("Not found", 404);
  const u = new URL(req.url);
  const rel = (u.searchParams.get("dir") || "").replace(/^[\\/]+|[\\/]+$/g, "");
  const root = path.resolve(p.rootPath);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return bad("Not allowed", 403);
  try {
    const ents = await fs.readdir(abs, { withFileTypes: true });
    const skip = new Set(SKIP_DIRS);
    const out = [];
    for (const e of ents) {
      if (e.name.startsWith(".git") || skip.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push({ name: e.name, path: relPath, kind: "dir" as const }); continue; }
      if (!e.isFile()) continue;
      const secret = SECRET_FILE_RE.test(relPath);
      const binary = BINARY_EXT.has(path.extname(e.name).toLowerCase());
      let size: number | undefined;
      try { size = (await fs.stat(path.join(abs, e.name))).size; } catch { /* ignore */ }
      out.push({ name: e.name, path: relPath, kind: "file" as const, size, secret, binary });
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    return ok({ dir: rel, entries: out });
  } catch { return bad("Folder not found", 404); }
}
