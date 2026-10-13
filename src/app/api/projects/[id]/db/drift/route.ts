// GET /api/projects/:id/db/drift?env=dev -> DriftResult (live schema snapshot vs tables declared in code)
import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/arkus/project";
import { computeDrift } from "@/lib/arkus/drift";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const env = new URL(req.url).searchParams.get("env") || "dev";
  return NextResponse.json(await computeDrift(project.id, env));
}
