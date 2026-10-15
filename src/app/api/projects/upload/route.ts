// POST multipart { name?, files[] (field "files", filename = relative path) } → writes the files under the
// repos folder (per user in hosted mode), creates a connected project, returns { id, slug }.
// Browsers can't hand a server a folder path, so hosted Arkus takes an upload instead.
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { bad, ok, slugify } from "../../_util";
import { authErrorResponse, currentUser, isCloud, requireDeveloper } from "@/lib/auth";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { SKIP_DIRS } from "@/lib/arkus/fs";

const REPOS_DIR = process.env.ARKUS_REPOS_DIR || path.join(process.cwd(), ".repos");
const MAX_FILES = 4000, MAX_TOTAL = 60 * 1024 * 1024, MAX_FILE = 2 * 1024 * 1024;
const SKIP = new Set(SKIP_DIRS);

export async function POST(req: Request) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  if (limitsOn() && limited(`upload:${clientIp(req)}`, 10, 60 * 60 * 1000)) return tooMany("uploads");
  const me = await currentUser();
  if (!me) return bad("Sign in required", 401);
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Expected a multipart upload"); }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return bad("Pick a folder with some files in it");
  if (files.length > MAX_FILES) return bad(`That folder has more than ${MAX_FILES} files after skipping dependencies. Zip it smaller or import from GitHub.`);
  const rel = (f: File) => (f.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const top = rel(files[0]).split("/")[0] || "upload";
  const rootName = String(form.get("name") || "").trim() || top;
  let slug = slugify(rootName);
  for (let i = 2; await prisma.project.findUnique({ where: { slug } }); i++) slug = `${slugify(rootName)}-${i}`;
  const dest = path.join(REPOS_DIR, isCloud() ? me.id : "", `${slug}-upload`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  let total = 0, written = 0, skipped = 0;
  for (const f of files) {
    const r = rel(f);
    const parts = r.split("/").filter(Boolean);
    const inner = parts.length > 1 && parts[0] === top ? parts.slice(1) : parts; // drop the folder's own name
    if (!inner.length || inner.some((p) => p === ".." || SKIP.has(p) || p === ".git")) { skipped++; continue; }
    if (f.size > MAX_FILE) { skipped++; continue; }
    total += f.size;
    if (total > MAX_TOTAL) return bad(`Upload is larger than ${Math.round(MAX_TOTAL / 1024 / 1024)} MB after skipping dependencies. Import from GitHub instead.`);
    const abs = path.join(dest, ...inner);
    if (!abs.startsWith(dest + path.sep)) { skipped++; continue; }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(await f.arrayBuffer()));
    written++;
  }
  if (!written) return bad("Nothing usable in that folder (dependencies and build output are skipped).");
  const project = await prisma.project.create({ data: { ownerId: me.id, name: rootName, slug, mode: "connected", rootPath: dest, repoUrl: null } });
  await prisma.activity.create({ data: { projectId: project.id, kind: "connect", what: `Uploaded ${written} files (${skipped} skipped)` } });
  return ok({ id: project.id, slug: project.slug, written, skipped }, { status: 201 });
}
