// Read-only code peek for the inspector. Path-safe: only files inside the project's folder.
import fs from "node:fs/promises";
import path from "node:path";
import { scrubSecrets, SECRET_FILE_RE } from "@/lib/arkus/fs";
import { bad, ok } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p || !p.rootPath) return bad("Not found", 404);
  const u = new URL(req.url);
  const rel = u.searchParams.get("file") || "";
  const from = Math.max(1, Number(u.searchParams.get("from") || 1));
  const to = Number(u.searchParams.get("to") || from + 80);
  const root = path.resolve(p.rootPath);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) || SECRET_FILE_RE.test(rel)) return bad("Not allowed", 403);
  try {
    const text = scrubSecrets(await fs.readFile(abs, "utf8")).text;
    const lines = text.split(/\r?\n/);
    return ok({ file: rel, from, to: Math.min(to, lines.length), total: lines.length, lines: lines.slice(from - 1, to) });
  } catch { return bad("File not found", 404); }
}
