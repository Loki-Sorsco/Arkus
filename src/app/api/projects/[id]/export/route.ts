// "Your code keeps working without Arkus": export the whole spec (graph + bindings) as JSON.
import { loadGraph } from "@/lib/arkus/graph";
import { bad } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const g = await loadGraph(p.id);
  const body = JSON.stringify({ project: { name: p.name, mode: p.mode, stack: JSON.parse(p.stack) }, exportedAt: new Date().toISOString(), version: g.version, nodes: g.nodes, edges: g.edges, bindings: g.bindings }, null, 2);
  return new Response(body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${p.slug}-spec.json"` } });
}
