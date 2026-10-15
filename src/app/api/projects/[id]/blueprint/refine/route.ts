// POST { instruction } | { flipAssumption: id } | { blueprint } → new blueprint version
import { resolveProject } from "@/lib/arkus/project";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { refineBlueprint, flipAssumption, runDesignChecks } from "@/lib/arkus/architect/generate";
import { validateBlueprint } from "@/lib/arkus/architect/schema";
import { latestBlueprint, saveBlueprintVersion, logDesign } from "@/lib/arkus/architect/store";

const Body = z.union([
  z.object({ instruction: z.string().min(2).max(4000) }),
  z.object({ flipAssumption: z.string().min(1).max(64) }),
  z.object({ blueprint: z.record(z.string(), z.unknown()) }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  const body = parsed.data;

  const current = await latestBlueprint(id);
  if (!current && !("blueprint" in body)) return NextResponse.json({ error: "no_blueprint" }, { status: 409 });

  let result: { blueprint: ReturnType<typeof validateBlueprint>["blueprint"]; aiUsed: boolean; issues: ReturnType<typeof validateBlueprint>["issues"] };
  let what: string;
  if ("instruction" in body) {
    const r = await refineBlueprint({ blueprint: current!.blueprint, instruction: body.instruction });
    result = r; what = `Refined blueprint: ${body.instruction.slice(0, 80)}`;
  } else if ("flipAssumption" in body) {
    if (!current!.blueprint.assumptions.some((a) => a.id === body.flipAssumption)) return NextResponse.json({ error: "unknown_assumption" }, { status: 400 });
    const r = await flipAssumption(current!.blueprint, body.flipAssumption);
    result = r; what = `Flipped assumption ${body.flipAssumption}`;
  } else {
    const v = validateBlueprint(body.blueprint);
    if (!v.blueprint || v.issues.some((i) => i.level === "error")) return NextResponse.json({ error: "invalid_blueprint", issues: v.issues }, { status: 422 });
    v.blueprint.checks = runDesignChecks(v.blueprint);
    result = { blueprint: v.blueprint, aiUsed: false, issues: v.issues }; what = "Edited blueprint manually";
  }
  if (!result.blueprint) return NextResponse.json({ error: "refine_failed", issues: result.issues }, { status: 500 });

  const { version } = await saveBlueprintVersion(id, result.blueprint, current?.prompt ?? result.blueprint.summary);
  await logDesign(id, `${what} → v${version}`, { version, aiUsed: result.aiUsed });
  return NextResponse.json({ blueprint: result.blueprint, version, checks: result.blueprint.checks, aiUsed: result.aiUsed, issues: result.issues });
}
