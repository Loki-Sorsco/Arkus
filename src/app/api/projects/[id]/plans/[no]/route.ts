import { prisma, j } from "@/lib/db";
import { previewPlan, verifyPlan } from "@/lib/arkus/plans";
import { bad, ok, readJson } from "../../../../_util";
import { resolveProject } from "@/lib/arkus/project";
import { shapePlan } from "@/lib/arkus/project";

type Ctx = { params: Promise<{ id: string; no: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const { id, no } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const plan = await prisma.plan.findUnique({ where: { projectId_no: { projectId: p.id, no: Number(no) } } });
  if (!plan) return bad("Not found", 404);
  return ok(shapePlan(plan));
}

/** PATCH { action: "preview" | "approve" | "verify" | "comment" | "discard" | "decide" | "reopen", text?, decision? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id, no } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const n = Number(no);
  const plan = await prisma.plan.findUnique({ where: { projectId_no: { projectId: p.id, no: n } } });
  if (!plan) return bad("Not found", 404);
  const body = await readJson<{ action: string; text?: string; decision?: number; confirm?: string }>(req);
  const log = (what: string) => prisma.activity.create({ data: { projectId: p.id, env: plan.env, kind: "plan", what, meta: JSON.stringify({ planNo: n }) } });
  switch (body.action) {
    case "preview": {
      await prisma.plan.update({ where: { id: plan.id }, data: { pipeline: "previewing" } });
      const u = await previewPlan(p.id, n);
      await log(`Plan #${n} checks ${u.pipeline === "checks_passing" ? "passing" : "failed"}`);
      return ok(shapePlan(u));
    }
    case "approve": {
      if (plan.pipeline !== "checks_passing") return bad("Approve is enabled only when checks are passing");
      if (plan.env === "prod" && body.confirm !== p.name) return bad(`Type the project name (${p.name}) to confirm a production change`);
      const u = await prisma.plan.update({ where: { id: plan.id }, data: { pipeline: "approved" } });
      await log(`Plan #${n} approved — hand-off guide ready`);
      return ok(shapePlan(u));
    }
    case "verify": {
      const r = await verifyPlan(p.id, n);
      return ok({ ...shapePlan(r.plan), verify: { done: r.done, total: r.total, results: r.results } });
    }
    case "comment": {
      const comments = j<{ at: string; text: string }[]>(plan.comments, []);
      comments.push({ at: new Date().toISOString(), text: String(body.text || "").slice(0, 2000) });
      return ok(shapePlan(await prisma.plan.update({ where: { id: plan.id }, data: { comments: JSON.stringify(comments) } })));
    }
    case "decide": {
      const d = j<Record<string, unknown>>(plan.decisions, {});
      const er = d.existingRows as { chosen: number } | undefined;
      if (er && typeof body.decision === "number") er.chosen = body.decision;
      return ok(shapePlan(await prisma.plan.update({ where: { id: plan.id }, data: { decisions: JSON.stringify(d) } })));
    }
    case "discard": {
      await prisma.plan.update({ where: { id: plan.id }, data: { pipeline: "failed" } });
      await log(`Plan #${n} discarded`);
      return ok({ ok: true });
    }
    case "reopen": return ok(shapePlan(await prisma.plan.update({ where: { id: plan.id }, data: { pipeline: "draft" } })));
    default: return bad("unknown action");
  }
}

export async function DELETE(_: Request, { params }: Ctx) {
  const { id, no } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  await prisma.plan.delete({ where: { projectId_no: { projectId: p.id, no: Number(no) } } });
  return ok({ ok: true });
}
