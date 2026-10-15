// POST { env, spec, polish? } → { path, content, notes, exists }. Renders the route file a New API spec
// describes (template first; with polish=true and AI on, adapted to an existing handler's style) and says
// whether that file already exists. Nothing is written: creation goes through PUT /file with baseHash null.
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { aiReady } from "@/lib/llm";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { gatherGrounding } from "@/lib/arkus/actions-grounding";
import { generateRoute, parseSpec } from "@/lib/arkus/apigen";
import { polishRoute } from "@/lib/arkus/apigen-ai";
import { isEnv } from "@/lib/arkus/dbsources";
import { readCurrent, resolveInside } from "@/lib/arkus/filewrite";
import { resolveProject } from "@/lib/arkus/project";
import { bad, ok, readJson } from "../../../../_util";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  if (!p.rootPath) return bad("This project has no code folder");
  const body = await readJson<{ env?: unknown; spec?: unknown; polish?: unknown }>(req);
  const spec = parseSpec(body.spec);
  if ("error" in spec) return bad(spec.error);
  const env = isEnv(body.env) ? body.env : "dev";
  const polish = body.polish !== false && (await aiReady());
  if (limitsOn() && limited(`${polish ? "apigen-ai" : "apigen"}:${clientIp(req)}`, polish ? 30 : 120, 600000)) return tooMany("generate requests");
  try {
    const g = await gatherGrounding(p.id, env, `${spec.method} ${spec.path} ${spec.table || ""}`);
    let gen = generateRoute(spec, g);
    if (polish) gen = await polishRoute(spec, gen, g);
    const r = resolveInside(p.rootPath, gen.path);
    if ("error" in r) return bad(r.error, r.status);
    const exists = (await readCurrent(r.abs)) !== null;
    return ok({ path: r.rel, content: gen.content, notes: gen.notes, exists, polished: polish });
  } catch (e) {
    return bad((e as Error).message || "Could not generate the route", 500);
  }
}
