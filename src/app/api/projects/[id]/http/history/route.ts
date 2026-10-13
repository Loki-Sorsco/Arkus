// GET /api/projects/:id/http/history → { entries } newest first (capped at 100) · DELETE → clears it.
import { bad, ok } from "@/app/api/_util";
import { resolveProject } from "@/lib/arkus/project";
import { clearHistory, listHistory } from "@/lib/arkus/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  return ok({ entries: await listHistory(p.id) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  await clearHistory(p.id);
  return ok({ ok: true });
}
