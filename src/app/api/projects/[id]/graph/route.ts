import { loadGraph } from "@/lib/arkus/graph";
import { bad, ok } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  return ok(await loadGraph(p.id));
}
