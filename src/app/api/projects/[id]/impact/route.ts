import { impactOf, loadGraph } from "@/lib/arkus/graph";
import { bad, ok } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return bad("key required");
  const g = await loadGraph(p.id);
  return ok({ key, ...impactOf(g, key) });
}
