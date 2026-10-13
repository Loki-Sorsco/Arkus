// GET → { configured, source } · POST { key } → verify with Groq + store encrypted · DELETE → forget.
import { bad, ok, readJson } from "../../_util";
import { aiKeyInfo, clearAiKey, setAiKey } from "@/lib/llm";

export async function GET() { return ok(await aiKeyInfo()); }

export async function POST(req: Request) {
  const body = await readJson<{ key?: string }>(req);
  if (!body.key?.trim()) return bad("Paste a Groq API key");
  try { await setAiKey(body.key); return ok(await aiKeyInfo()); }
  catch (e) { return bad((e as Error).message); }
}

export async function DELETE() { await clearAiKey(); return ok(await aiKeyInfo()); }
