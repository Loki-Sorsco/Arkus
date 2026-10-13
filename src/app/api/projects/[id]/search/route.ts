import { searchProject } from "@/lib/arkus/graph";
import { bad, ok } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const q = new URL(req.url).searchParams.get("q") || "";
  return ok(await searchProject(p.id, q));
}
