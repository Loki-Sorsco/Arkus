// GET /api/projects/:id/http/saved → { requests } · POST { ...SavedRequest } upserts one (id generated
// when missing) → { request } · DELETE ?id= → { ok }.
import { bad, ok, readJson } from "@/app/api/_util";
import { resolveProject } from "@/lib/arkus/project";
import { deleteSaved, listSaved, upsertSaved, type SavedRequest } from "@/lib/arkus/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  return ok({ requests: await listSaved(p.id) });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  const body = await readJson<Partial<SavedRequest>>(req);
  if (!body || typeof body !== "object") return bad("request body required");
  return ok({ request: await upsertSaved(p.id, body) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  const rid = new URL(req.url).searchParams.get("id");
  if (!rid) return bad("id is required");
  return ok({ ok: await deleteSaved(p.id, rid) });
}
