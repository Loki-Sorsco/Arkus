// GET  → { isRepo, mode: "local" | "pr" | "branch", branch, remote, dirty, ahead? } so the UI knows whether
//        a Publish bar makes sense (never for local folders).
// POST { message?, summaries? } → projects cloned from a git URL: commit on a fresh arkus/* branch, push it with
//        the saved GitHub token and open a pull request (GitHub) or just push the branch (other hosts).
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { gitState, publish } from "@/lib/arkus/gitpublish";
import { resolveProject } from "@/lib/arkus/project";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { bad, ok, readJson } from "../../../../_util";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const s = await gitState(p);
  return ok({ isRepo: s.isRepo, mode: s.mode, branch: s.branch, remote: s.remoteUrl ? s.remoteUrl.replace(/:\/\/[^@/]+@/, "://") : s.remote, dirty: s.dirty, ...(s.ahead !== undefined ? { ahead: s.ahead } : {}), ...(s.reason ? { reason: s.reason } : {}) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  if (limitsOn() && limited(`publish:${clientIp(req)}`, 20, 600000)) return tooMany("publish requests");
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  if (!p.rootPath) return bad("This project has no code folder");
  if (!p.repoUrl) return ok({ ok: false, mode: "local", error: "This project is a local folder: files are saved to disk, commit them with git when you are ready." }, { status: 400 });
  const body = await readJson<{ message?: unknown; summaries?: unknown }>(req);
  const message = typeof body.message === "string" ? body.message : undefined;
  const summaries = Array.isArray(body.summaries) ? (body.summaries as unknown[]).filter((s): s is string => typeof s === "string") : undefined;
  try {
    const r = await publish(p, { message, summaries });
    return ok(r, { status: r.ok ? 200 : r.error === "nothing to publish" ? 400 : 200 });
  } catch (e) {
    return bad((e as Error).message || "Publish failed", 500);
  }
}
