// POST { env, endpointKey, request } → { path, baseHash, before, after, summary, notes }. Asks the AI to rewrite
// the endpoint's file for a plain-language request; the caller shows the diff and applies it with
// PUT /file { baseHash } so a file that changed meanwhile is refused (409). Proposes only; writes nothing.
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { aiReady } from "@/lib/llm";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { gatherGrounding } from "@/lib/arkus/actions-grounding";
import { proposeChange } from "@/lib/arkus/apigen-ai";
import { isEnv } from "@/lib/arkus/dbsources";
import { readCurrent, resolveInside } from "@/lib/arkus/filewrite";
import { EDIT_MAX_FILE_BYTES } from "@/lib/arkus/fs";
import { loadGraph } from "@/lib/arkus/graph";
import { resolveProject } from "@/lib/arkus/project";
import { bad, ok, readJson } from "../../../../_util";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  if (limitsOn() && limited(`apichange:${clientIp(req)}`, 30, 600000)) return tooMany("change requests");
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  if (!p.rootPath) return bad("This project has no code folder");
  if (!(await aiReady())) return bad("AI is off");
  const body = await readJson<{ env?: unknown; endpointKey?: unknown; request?: unknown }>(req);
  const request = typeof body.request === "string" ? body.request.trim() : "";
  const key = typeof body.endpointKey === "string" ? body.endpointKey : "";
  if (!request) return bad("Describe the change");
  if (!key) return bad("endpointKey is required");
  const env = isEnv(body.env) ? body.env : "dev";
  const g = await loadGraph(p.id);
  const ep = g.nodes.find((n) => n.type === "endpoint" && n.key === key);
  if (!ep) return bad("That endpoint is not in the map; re-index and try again", 404);
  if (!ep.file) return bad("The map does not know which file handles this endpoint");
  const r = resolveInside(p.rootPath, ep.file);
  if ("error" in r) return bad(r.error, r.status);
  const current = await readCurrent(r.abs);
  if (!current) return bad("The handler file no longer exists", 404);
  if (Buffer.byteLength(current.content, "utf8") > EDIT_MAX_FILE_BYTES) return bad("The file is too large to edit in Arkus", 413);
  try {
    const grounding = await gatherGrounding(p.id, env, `${request} ${ep.name}`);
    const method = String(ep.attrs?.method || ep.name.split(" ")[0] || "GET"), path = String(ep.attrs?.path || ep.name.replace(/^[A-Z]+\s+/, ""));
    const res = await proposeChange({ method, path, file: r.rel, content: current.content, request }, grounding);
    if (!res) return bad("The AI did not answer in time. Try again, or make the request more specific.", 504);
    if ("error" in res) return bad(res.error, 422);
    await prisma.activity.create({ data: { projectId: p.id, env, kind: "ask", what: `Change proposed for ${ep.name}: ${request.slice(0, 100)}`, meta: JSON.stringify({ file: r.rel, unchanged: res.content === current.content }) } }).catch(() => {});
    return ok({ path: r.rel, baseHash: current.hash, before: current.content, after: res.content, summary: res.summary, notes: res.notes, unchanged: res.content === current.content });
  } catch (e) {
    return bad((e as Error).message || "Could not propose the change", 500);
  }
}
