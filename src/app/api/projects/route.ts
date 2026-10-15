import fs from "node:fs/promises";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import path from "node:path";
import { prisma, j } from "@/lib/db";
import { bad, ok, readJson, slugify } from "../_util";
import { CloneError, cloneOrPull, friendlyCloneMessage, getGithubToken, setGithubToken, verifyGithubToken } from "@/lib/arkus/gitclone";
import { currentUser, isCloud } from "@/lib/auth";

const REPOS_DIR = process.env.ARKUS_REPOS_DIR || path.join(process.cwd(), ".repos");

export async function GET() {
  const me = await currentUser();
  if (!me) return bad("Sign in required", 401);
  const projects = await prisma.project.findMany({ where: { ownerId: me.id }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { plans: true } }, snapshots: { where: { status: "ready" }, orderBy: { createdAt: "desc" }, take: 1 }, sources: { where: { kind: "db" }, select: { env: true, status: true } } } });
  return ok(projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug, mode: p.mode, status: p.status, rootPath: p.rootPath, repoUrl: p.repoUrl, stack: j(p.stack, {}), plans: p._count.plans, lastIndexed: p.snapshots[0]?.createdAt ?? null, stats: j(p.snapshots[0]?.stats, {}), dbConnected: p.sources.some((s) => s.status === "ok"), dbEnvs: p.sources.filter((s) => s.status === "ok").map((s) => s.env), updatedAt: p.updatedAt })));
}

/** POST { mode: "connected", rootPath } | { mode: "connected", repoUrl } | { mode: "designed", name, idea? } */
export async function POST(req: Request) {
  if (limitsOn() && limited(`import:${clientIp(req)}`, 20, 3600000)) return tooMany("import requests");
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const me = await currentUser();
  if (!me) return bad("Sign in required", 401);
  const body = await readJson<{ mode?: string; name?: string; rootPath?: string; repoUrl?: string; token?: string; rememberToken?: boolean }>(req);
  const mode = body.mode === "designed" ? "designed" : "connected";
  let rootPath = body.rootPath?.trim();
  if (isCloud() && mode === "connected" && !body.repoUrl?.trim()) return bad("Hosted Arkus imports from a git URL. Run `npx arkus` on your machine to open a local folder.");
  let name = body.name?.trim();
  if (mode === "connected") {
    if (body.repoUrl?.trim()) {
      const url = body.repoUrl.trim();
      if (!/^(https:\/\/|git@)[\w.@:/-]+$/.test(url)) return bad("That doesn't look like a git URL");
      const repoName = url.split("/").pop()!.replace(/\.git$/, "");
      await fs.mkdir(REPOS_DIR, { recursive: true });
      rootPath = path.join(REPOS_DIR, isCloud() ? me.id : "", repoName);
      let exists = false;
      try { await fs.access(path.join(rootPath, ".git")); exists = true; } catch { /* fresh clone */ }
      // Private repos: a token sent with the request wins (remembered unless told otherwise); else the saved one.
      let token = await getGithubToken();
      if (body.token?.trim()) {
        try { token = body.rememberToken === false ? (await verifyGithubToken(body.token)).token : (await setGithubToken(body.token), body.token.trim()); }
        catch (e) { return Response.json({ error: (e as Error).message, code: "auth" }, { status: 401 }); }
      }
      try { await cloneOrPull(url, rootPath, exists, token); }
      catch (e) {
        if (e instanceof CloneError) return Response.json({ error: friendlyCloneMessage(e, Boolean(token)), code: e.code }, { status: e.code === "auth" ? 401 : 400 });
        return bad(`Clone failed: ${(e as Error).message.split("\n")[0]}`);
      }
      name ||= repoName;
    }
    if (!rootPath) return bad("Pick a folder or paste a git URL");
    try { const st = await fs.stat(rootPath); if (!st.isDirectory()) throw new Error(); } catch { return bad("Folder not found"); }
    name ||= path.basename(rootPath);
  }
  if (!name) return bad("Give the project a name");
  let slug = slugify(name);
  for (let i = 2; await prisma.project.findUnique({ where: { slug } }); i++) slug = `${slugify(name)}-${i}`;
  const project = await prisma.project.create({ data: { ownerId: me.id, name, slug, mode, rootPath: mode === "connected" ? rootPath : null, repoUrl: body.repoUrl?.trim() || null } });
  await prisma.activity.create({ data: { projectId: project.id, kind: mode === "designed" ? "design" : "connect", what: mode === "designed" ? `Started designing ${name}` : `Connected ${rootPath}` } });
  return ok(project, { status: 201 });
}
