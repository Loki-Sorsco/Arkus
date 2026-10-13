// POST { idea } → 3–5 guided follow-up questions (LLM) or canned ones offline
import { NextResponse } from "next/server";
import { z } from "zod";
import { guidedQuestions } from "@/lib/arkus/architect/generate";
import { pickTemplate, templateLabel } from "@/lib/arkus/architect/templates";

const Body = z.object({ idea: z.string().min(4).max(4000) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  const { questions, aiUsed } = await guidedQuestions(parsed.data.idea);
  const template = pickTemplate(parsed.data.idea);
  return NextResponse.json({ questions, aiUsed, suggestedTemplate: template, suggestedTemplateLabel: templateLabel(template) });
}
