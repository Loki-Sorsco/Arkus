// GET ?format=prisma|sql|openapi|tasks|spec&engine=postgres|sqlite&download=1
import { resolveProject } from "@/lib/arkus/project";
import { NextResponse } from "next/server";
import { latestBlueprint } from "@/lib/arkus/architect/store";
import { toPrismaSchema, toSqlDdl, toOpenApi, toTasksMarkdown, toSpecJson } from "@/lib/arkus/architect/export";

const FORMATS = ["prisma", "sql", "openapi", "tasks", "spec"] as const;
type Format = (typeof FORMATS)[number];

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idOrSlug } = await params;
  const resolved = await resolveProject(idOrSlug);
  if (!resolved) return Response.json({ error: "project_not_found" }, { status: 404 });
  const id = resolved.id;
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "spec") as Format;
  const engineRaw = url.searchParams.get("engine") ?? "";
  const download = url.searchParams.get("download") === "1";
  if (!FORMATS.includes(format)) return NextResponse.json({ error: "bad_format", formats: FORMATS }, { status: 400 });

  const project = await resolveProject(id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const latest = await latestBlueprint(id);
  if (!latest) return NextResponse.json({ error: "no_blueprint" }, { status: 404 });
  const bp = latest.blueprint;
  const slug = (bp.name || project.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "blueprint";

  let body: string; let type: string; let filename: string;
  switch (format) {
    case "prisma": {
      const provider = engineRaw === "postgres" || engineRaw === "postgresql" ? "postgresql" : engineRaw === "mysql" ? "mysql" : "sqlite";
      body = toPrismaSchema(bp, provider); type = "text/plain; charset=utf-8"; filename = "schema.prisma"; break;
    }
    case "sql": {
      const engine = engineRaw === "sqlite" ? "sqlite" : "postgres";
      body = toSqlDdl(bp, engine); type = "application/sql; charset=utf-8"; filename = `${slug}.${engine}.sql`; break;
    }
    case "openapi": body = JSON.stringify(toOpenApi(bp), null, 2); type = "application/json"; filename = "openapi.json"; break;
    case "tasks": body = toTasksMarkdown(bp); type = "text/markdown; charset=utf-8"; filename = "TASKS.md"; break;
    default: body = JSON.stringify(toSpecJson(bp), null, 2); type = "application/json"; filename = `${slug}.blueprint.json`;
  }
  return new NextResponse(body, {
    headers: {
      "content-type": type,
      "x-arkus-blueprint-version": String(latest.version),
      ...(download ? { "content-disposition": `attachment; filename="${filename}"` } : {}),
    },
  });
}
