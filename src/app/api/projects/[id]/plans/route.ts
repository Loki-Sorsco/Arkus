import { prisma } from "@/lib/db";
import { shapePlan } from "@/lib/arkus/project";
import { createPlan, type PlanIntent } from "@/lib/arkus/plans";
import { bad, ok, readJson } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const plans = await prisma.plan.findMany({ where: { projectId: p.id }, orderBy: { no: "desc" } });
  return ok(plans.map(shapePlan));
}

/** POST { intent: PlanIntent, env? } → plan */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const body = await readJson<{ intent?: PlanIntent; env?: string }>(req);
  if (!body.intent?.kind) return bad("intent required");
  try {
    const plan = await createPlan(p.id, body.intent, body.env || "dev");
    return ok(shapePlan(plan), { status: 201 });
  } catch (e) { return bad((e as Error).message); }
}
