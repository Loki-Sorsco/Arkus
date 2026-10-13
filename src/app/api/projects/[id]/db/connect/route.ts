// Compatibility alias. GET ?env -> { source, snapshot } for that env (public shape) · POST -> same as POST db/sources.
import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/arkus/project";
import { listDbSources } from "@/lib/arkus/dbsources";
import { POST as sourcesPost } from "../sources/route";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  return sourcesPost(req, ctx);
}

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const env = new URL(req.url).searchParams.get("env") || "dev";
  const source = (await listDbSources(project.id)).find(s => s.env === env) ?? null;
  return NextResponse.json({ source, snapshot: source?.snapshot ?? null });
}
