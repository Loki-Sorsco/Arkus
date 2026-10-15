// POST { env, action } → runs ONE confirmed action through the existing safe write paths and returns
// { ok, result, error? }. insert_row / update_row → applyMutation; add_column → ddl.addColumn;
// write_file → filewrite (create, or overwrite against the current hash fetched server-side);
// run_sql → ddl.runDdl (ALTER TABLE / CREATE INDEX / CREATE TABLE only). Prod is gated client-side.
import path from "node:path";
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { validateAction } from "@/lib/arkus/actions";
import { gatherGrounding } from "@/lib/arkus/actions-grounding";
import { redact } from "@/lib/arkus/dbconn";
import { isEnv } from "@/lib/arkus/dbsources";
import { addColumn, runDdl } from "@/lib/arkus/ddl";
import { FileWriteError, readCurrent, resolveInside, writeProjectFile } from "@/lib/arkus/filewrite";
import { applyMutation, MutationError } from "@/lib/arkus/mutate";
import { resolveProject } from "@/lib/arkus/project";
import { bad, ok, readJson } from "../../../../_util";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const body = await readJson<{ env?: unknown; action?: unknown }>(req);
  const env = isEnv(body.env) ? body.env : "dev";
  if (!body.action || typeof body.action !== "object") return bad("action is required");
  const kind = String((body.action as { kind?: unknown }).kind || "");
  // Re-validate against the current snapshot / repo: the client's copy may be stale or edited.
  const g = await gatherGrounding(p.id, env, "");
  const v = validateAction(body.action, g);
  if ("drop" in v) return bad(`This action can't be applied: ${v.drop}`);
  const a = v.action;
  try {
    if (a.kind === "insert_row") return ok({ ok: true, result: await applyMutation(p.id, env, { op: "insert", table: a.table, values: a.values }) });
    if (a.kind === "update_row") return ok({ ok: true, result: await applyMutation(p.id, env, { op: "update", table: a.table, pk: a.pk, set: a.set }) });
    if (a.kind === "add_column") return ok({ ok: true, result: await addColumn(p.id, env, { table: a.table, column: a.column, type: a.type, nullable: a.nullable, defaultValue: a.defaultValue }) });
    if (a.kind === "run_sql") return ok({ ok: true, result: await runDdl(p.id, env, a.sql) });
    if (a.kind === "write_file") {
      if (!p.rootPath) return bad("This project has no code folder");
      const r = resolveInside(p.rootPath, a.path);
      if ("error" in r) return bad(r.error, r.status);
      const current = await readCurrent(r.abs);
      if (a.create && current) return ok({ ok: false, error: `${a.path} already exists; the action was proposed as a new file. Ask again so it can be rewritten against the current content.` }, { status: 409 });
      if (!a.create && !current) return ok({ ok: false, error: `${a.path} does not exist any more` }, { status: 404 });
      const result = await writeProjectFile({ id: p.id, rootPath: p.rootPath }, { path: a.path, content: a.content, baseHash: current ? current.hash : null });
      return ok({ ok: true, result: { ...result, local: !p.repoUrl, upload: /-upload$/i.test(path.basename(p.rootPath)) } });
    }
    return bad(`Unknown action kind "${kind}"`);
  } catch (e) {
    if (e instanceof MutationError) return ok({ ok: false, error: e.message, ...e.extra }, { status: e.status });
    if (e instanceof FileWriteError) return ok({ ok: false, error: e.message, ...e.extra }, { status: e.status });
    return ok({ ok: false, error: redact((e as Error).message || "Could not apply the action") }, { status: 500 });
  }
}
