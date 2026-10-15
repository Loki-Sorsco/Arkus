// POST { env, question, history? } → { reply, actions, needs? } (see lib/arkus/actions.ts). Proposes only;
// nothing is executed until the user confirms an action through /actions/apply.
import { authErrorResponse, requireDeveloper } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { aiReady } from "@/lib/llm";
import { clientIp, limited, limitsOn, tooMany } from "@/lib/ratelimit";
import { proposeActions } from "@/lib/arkus/actions";
import type { AskMessage } from "@/lib/arkus/ask";
import { isEnv } from "@/lib/arkus/dbsources";
import { resolveProject } from "@/lib/arkus/project";
import { bad, ok, readJson } from "../../../_util";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireDeveloper(); } catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  if (limitsOn() && limited(`actions:${clientIp(req)}`, 40, 600000)) return tooMany("action requests");
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  if (!(await aiReady())) return bad("AI is off");
  const body = await readJson<{ env?: unknown; question?: unknown; history?: unknown }>(req);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return bad("Say what you want to change");
  const env = isEnv(body.env) ? body.env : "dev";
  const history: AskMessage[] = Array.isArray(body.history)
    ? (body.history as unknown[]).filter((m): m is AskMessage => !!m && typeof m === "object" && ((m as AskMessage).role === "user" || (m as AskMessage).role === "assistant") && typeof (m as AskMessage).content === "string").slice(-10)
    : [];
  try {
    const result = await proposeActions(p.id, env, question, history);
    await prisma.activity.create({ data: { projectId: p.id, env, kind: "ask", what: `Proposed: ${question.slice(0, 110)}`, meta: JSON.stringify({ actions: result.actions.map((a) => a.kind), needs: Boolean(result.needs), dropped: result.dropped?.length || 0 }) } }).catch(() => {});
    return ok(result);
  } catch (e) {
    return bad((e as Error).message || "Could not propose a change", 500);
  }
}
