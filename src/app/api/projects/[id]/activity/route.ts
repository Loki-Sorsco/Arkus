import { prisma, j } from "@/lib/db";
import { bad, ok } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind");
  const env = u.searchParams.get("env");
  const rows = await prisma.activity.findMany({ where: { projectId: p.id, ...(kind ? { kind } : {}), ...(env ? { env } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
  return ok(rows.map((r) => ({ ...r, meta: j(r.meta, {}) })));
}
