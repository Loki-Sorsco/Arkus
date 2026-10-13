// GET /api/projects/:id/http/env?env=dev → { env, value } (secrets masked, hasToken)
// PUT /api/projects/:id/http/env { env, value: HttpEnv } → same; masked token/password keep the stored secret.
import { bad, ok, readJson } from "@/app/api/_util";
import { resolveProject } from "@/lib/arkus/project";
import { getEnv, maskEnv, putEnv, type HttpEnv } from "@/lib/arkus/http";

const ENVS = ["dev", "preview", "prod"];
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  const env = new URL(req.url).searchParams.get("env") || "dev";
  if (!ENVS.includes(env)) return bad("env must be dev, preview or prod");
  return ok({ env, value: maskEnv(await getEnv(p.id, env)) });
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("project_not_found", 404);
  const body = await readJson<{ env?: string; value?: HttpEnv }>(req);
  const env = body.env || "dev";
  if (!ENVS.includes(env)) return bad("env must be dev, preview or prod");
  if (!body.value || typeof body.value !== "object") return bad("value is required");
  return ok({ env, value: maskEnv(await putEnv(p.id, env, body.value)) });
}
