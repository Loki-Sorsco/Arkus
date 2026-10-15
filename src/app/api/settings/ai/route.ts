// AI settings for the current user.
//   GET  → aiStatus() + masked key + provider catalogue (labels, defaults, hints; never keys)
//   POST { mode: "included" } | { mode: "byok", provider, key, model?, baseUrl? } | { mode: "off" }
//   POST { test: true } → one tiny completion with the resolved config → { ok, ms, model, error? }
//   DELETE → forget the saved choice (back to included)
import { bad, ok, readJson } from "../../_util";
import { aiStatus } from "@/lib/llm";
import { loadConfig, maskKey, resetConfig, resolve, saveConfig, includedConfig } from "@/lib/ai/config";
import { complete, isProvider, PROVIDERS, verifyKey, type Provider } from "@/lib/ai/providers";

type Body = { test?: boolean; mode?: string; provider?: string; key?: string; model?: string; baseUrl?: string };

async function status() {
  const s = await aiStatus();
  const cfg = await loadConfig();
  const providers = (Object.keys(PROVIDERS) as Provider[]).map((id) => {
    const p = PROVIDERS[id];
    return { id, label: p.label, model: p.model, fastModel: p.fastModel, keyHint: p.keyHint, getKeyUrl: p.getKeyUrl, needsBaseUrl: p.needsBaseUrl, keyOptional: p.keyOptional, baseUrl: p.baseUrl };
  });
  const byok = cfg.mode === "byok" ? { provider: cfg.provider ?? null, model: cfg.model ?? null, baseUrl: cfg.baseUrl ?? null, keyMasked: maskKey(cfg.key) } : null;
  const included = includedConfig();
  return { ...s, byok, includedModel: included?.model ?? null, includedProvider: included?.provider ?? null, providers };
}

export async function GET() { return ok(await status()); }

export async function POST(req: Request) {
  const body = await readJson<Body>(req);
  if (body.test) return ok(await test());
  const mode = body.mode;
  if (mode === "off") { await saveConfig({ mode: "off" }); return ok(await status()); }
  if (mode === "included") {
    if (!includedConfig()) return bad("This Arkus has no included AI key. Use your own key instead, or set ARKUS_AI_KEY on the server.");
    await saveConfig({ mode: "included" });
    return ok(await status());
  }
  if (mode === "byok") {
    if (!isProvider(body.provider)) return bad("Pick a provider");
    const info = PROVIDERS[body.provider];
    const key = (body.key || "").trim();
    const model = (body.model || "").trim() || info.model;
    const baseUrl = (body.baseUrl || "").trim() || undefined;
    if (!model) return bad("Enter the model name your endpoint serves (for example llama3.1 or openai/gpt-4o-mini)");
    if (info.needsBaseUrl && !baseUrl) return bad("Enter the base URL of your endpoint (for example http://localhost:11434/v1)");
    if (!key) {
      // Allow keeping the saved key when only the model changes.
      const cur = await loadConfig(true);
      if (cur.mode === "byok" && cur.provider === body.provider && cur.key) { await saveConfig({ ...cur, model, baseUrl }); return ok(await status()); }
    }
    try { await verifyKey(body.provider, key, baseUrl, model); }
    catch (e) { return bad((e as Error).message); }
    await saveConfig({ mode: "byok", provider: body.provider, key, model, baseUrl });
    return ok(await status());
  }
  return bad("Send { mode: \"included\" | \"byok\" | \"off\" } or { test: true }");
}

export async function DELETE() { await resetConfig(); return ok(await status()); }

async function test(): Promise<{ ok: boolean; ms: number; model: string | null; error?: string }> {
  const r = await resolve(true);
  if (!r) return { ok: false, ms: 0, model: null, error: "AI is off. Pick Included or add your own key first." };
  const t0 = Date.now();
  try {
    const text = await complete({ provider: r.provider, key: r.key, baseUrl: r.baseUrl, model: r.fastModel, system: "Reply with the single word: ok", user: "Say ok", maxTokens: 20, temperature: 0 });
    const ms = Date.now() - t0;
    return text ? { ok: true, ms, model: r.fastModel } : { ok: false, ms, model: r.fastModel, error: "The model answered with empty text" };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, model: r.fastModel, error: (e as Error).message };
  }
}
