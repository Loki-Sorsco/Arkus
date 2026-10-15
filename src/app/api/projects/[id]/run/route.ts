// GET    /api/projects/:id/run → app status { running, pid?, url?, command?, startedAt?, log }
// POST   /api/projects/:id/run → start the app's dev server (local mode only, developers only)
// DELETE /api/projects/:id/run → stop it
// The first localhost URL the app prints is saved as the Dev base URL, so Live, Test and Live API share it.
import { bad, ok } from "@/app/api/_util";
import { authErrorResponse, isCloud, requireDeveloper } from "@/lib/auth";
import { resolveProject } from "@/lib/arkus/project";
import { getEnv, putEnv } from "@/lib/arkus/http";
import { appStatus, CLOUD_MSG, RunError, startApp, stopApp } from "@/lib/arkus/runner";

type Ctx = { params: Promise<{ id: string }> };
const onError = (e: unknown) => { const r = authErrorResponse(e); if (r) return r; if (e instanceof RunError) return bad(e.message, e.status); throw e; };

export async function GET(_req: Request, { params }: Ctx) {
  if (isCloud()) return bad(CLOUD_MSG);
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  try { return ok(appStatus(p)); } catch (e) { return onError(e); }
}

export async function POST(_req: Request, { params }: Ctx) {
  if (isCloud()) return bad(CLOUD_MSG);
  try { await requireDeveloper(); } catch (e) { return onError(e); }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  try {
    const status = startApp(p, { onUrl: async (url) => { const cur = await getEnv(p.id, "dev"); await putEnv(p.id, "dev", { ...cur, baseUrl: url }); } });
    return ok(status);
  } catch (e) { return onError(e); }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (isCloud()) return bad(CLOUD_MSG);
  try { await requireDeveloper(); } catch (e) { return onError(e); }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  try { return ok(await stopApp(p)); } catch (e) { return onError(e); }
}
