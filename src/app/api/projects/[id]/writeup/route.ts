import { endpointWriteup, senseCheck } from "@/lib/arkus/writeups";
import { bad, ok, readJson } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

type Ctx = { params: Promise<{ id: string }> };
/** GET ?key=endpoint:GET /x[&force=1] → Writeup */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const u = new URL(req.url);
  const key = u.searchParams.get("key");
  if (!key) return bad("key required");
  const w = await endpointWriteup(p.id, key, { force: u.searchParams.get("force") === "1" });
  if (!w) return bad("Endpoint not found", 404);
  return ok(w);
}
/** POST { text, endpoint, original? } → sense-check result */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const body = await readJson<{ text?: string; endpoint?: string; original?: string }>(req);
  return ok(await senseCheck(body.text || "", body.endpoint || "", body.original));
}
