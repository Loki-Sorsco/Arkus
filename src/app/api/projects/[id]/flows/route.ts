import { deriveFlows, nameFlowsWithAI } from "@/lib/arkus/flows";
import { loadGraph } from "@/lib/arkus/graph";
import { resolveProject } from "@/lib/arkus/project";
import { aiReady } from "@/lib/llm";
import { bad, ok } from "../../../_util";

type Ctx = { params: Promise<{ id: string }> };
/** GET ?ai=0|1 → { flows, ai, snapshotId }. ai=1 polishes titles with one cached Groq call (bounded ~6s). */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const wantAi = new URL(req.url).searchParams.get("ai") === "1";
  const g = await loadGraph(p.id);
  const flows = deriveFlows(g);
  if (!wantAi || !(await aiReady())) return ok({ flows, ai: false, snapshotId: g.snapshotId });
  const named = await nameFlowsWithAI(p.id, flows);
  return ok({ flows: named.flows, ai: named.ai, snapshotId: g.snapshotId });
}
