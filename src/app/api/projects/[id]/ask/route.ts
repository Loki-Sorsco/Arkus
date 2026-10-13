// POST { question, history? } → grounded answer with citations (see lib/arkus/ask.ts).
import { prisma } from "@/lib/db";
import { askProject, type AskMessage } from "@/lib/arkus/ask";
import { resolveProject } from "@/lib/arkus/project";
import { bad, ok, readJson } from "../../../_util";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  const body = await readJson<{ question?: unknown; history?: unknown; offline?: unknown }>(req);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return bad("Ask a question first");
  const history: AskMessage[] = Array.isArray(body.history)
    ? (body.history as unknown[]).filter((m): m is AskMessage => !!m && typeof m === "object" && ((m as AskMessage).role === "user" || (m as AskMessage).role === "assistant") && typeof (m as AskMessage).content === "string").slice(-10)
    : [];
  try {
    // `offline` is a dev-only switch to exercise the no-key answer path.
    const result = await askProject(p.id, question, history, { offline: process.env.NODE_ENV !== "production" && body.offline === true });
    await prisma.activity.create({ data: { projectId: p.id, kind: "ask", what: question.slice(0, 120), meta: JSON.stringify({ mode: result.mode, citations: result.citations.length, ms: result.context.ms }) } }).catch(() => {});
    return ok(result);
  } catch (e) {
    return bad((e as Error).message || "Could not answer", 500);
  }
}
