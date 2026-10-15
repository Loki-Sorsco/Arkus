// AI providers Arkus can talk to, all over plain fetch (no SDKs): OpenAI-compatible chat
// completions (OpenAI, Groq, Gemini's OpenAI endpoint, any custom endpoint such as OpenRouter or
// Ollama) and the Anthropic Messages API. Nothing here logs keys or echoes them in errors.

export type Provider = "groq" | "openai" | "anthropic" | "google" | "custom";

export type ProviderInfo = {
  label: string;
  /** Default model for the main (quality) path and the fast (cheap) path. */
  model: string;
  fastModel: string;
  baseUrl: string;
  /** Short human hint for what a key looks like, e.g. "gsk_…". */
  keyHint: string;
  keyPattern: RegExp | null;
  getKeyUrl: string | null;
  /** Wire protocol. */
  api: "openai" | "anthropic";
  /** Whether `response_format: json_object` can be sent. Others get a prompt instruction only. */
  jsonMode: boolean;
  /** Custom endpoints need a base URL from the user; an API key is optional there (Ollama). */
  needsBaseUrl: boolean;
  keyOptional: boolean;
};

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  groq: { label: "Groq", model: "openai/gpt-oss-120b", fastModel: "openai/gpt-oss-20b", baseUrl: "https://api.groq.com/openai/v1", keyHint: "gsk_…", keyPattern: /^gsk_[A-Za-z0-9]{20,}$/, getKeyUrl: "https://console.groq.com/keys", api: "openai", jsonMode: true, needsBaseUrl: false, keyOptional: false },
  openai: { label: "OpenAI", model: "gpt-4o-mini", fastModel: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", keyHint: "sk-…", keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, getKeyUrl: "https://platform.openai.com/api-keys", api: "openai", jsonMode: true, needsBaseUrl: false, keyOptional: false },
  anthropic: { label: "Anthropic", model: "claude-opus-5-5", fastModel: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com/v1", keyHint: "sk-ant-…", keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, getKeyUrl: "https://console.anthropic.com/settings/keys", api: "anthropic", jsonMode: false, needsBaseUrl: false, keyOptional: false },
  google: { label: "Google Gemini", model: "gemini-2.5-flash", fastModel: "gemini-2.5-flash-lite", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyHint: "AIza…", keyPattern: /^AIza[A-Za-z0-9_-]{30,}$/, getKeyUrl: "https://aistudio.google.com/apikey", api: "openai", jsonMode: false, needsBaseUrl: false, keyOptional: false },
  custom: { label: "OpenAI-compatible (OpenRouter, Ollama…)", model: "", fastModel: "", baseUrl: "", keyHint: "whatever your endpoint issues; leave empty for Ollama", keyPattern: null, getKeyUrl: null, api: "openai", jsonMode: true, needsBaseUrl: true, keyOptional: true },
};

export const isProvider = (p: unknown): p is Provider => typeof p === "string" && p in PROVIDERS;
const trimSlash = (u: string) => u.trim().replace(/\/+$/, "");
const TIMEOUT = 60_000;

/** Pull a short, key-free message out of a failed response body. */
async function apiError(res: Response, who: string): Promise<Error> {
  let msg = "";
  try { const b = (await res.json()) as { error?: { message?: string } | string; message?: string }; msg = typeof b.error === "string" ? b.error : b.error?.message || b.message || ""; } catch { /* non-json body */ }
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(msg))) return new Error(`${who} rejected the key. Check it was copied fully and has not been revoked.`);
  if (res.status === 404) return new Error(`${who} answered 404${msg ? `: ${msg.slice(0, 160)}` : ""}. Check the model name${who === "The endpoint" ? " and base URL" : ""}.`);
  if (res.status === 429) return new Error(`${who} is rate limiting this key (429). Try again in a moment.`);
  return new Error(`${who} answered ${res.status}${msg ? `: ${msg.slice(0, 160)}` : ""}`);
}
const who = (p: Provider) => (p === "custom" ? "The endpoint" : PROVIDERS[p].label);
const whoLower = (p: Provider) => (p === "custom" ? "the endpoint" : PROVIDERS[p].label);

function openaiHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}
function anthropicHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
}

/**
 * Check a key with the provider without storing it: list models (cheap, no tokens). Custom
 * endpoints that don't implement /models fall back to a one-token completion against `model`.
 */
export async function verifyKey(provider: Provider, key: string, baseUrl?: string, model?: string): Promise<void> {
  const info = PROVIDERS[provider];
  const k = key.trim();
  if (!k && !info.keyOptional) throw new Error(`Paste a ${info.label} API key`);
  if (k && info.keyPattern && !info.keyPattern.test(k)) throw new Error(`That doesn't look like a key from ${info.label} (expected ${info.keyHint})`);
  const base = trimSlash(baseUrl || info.baseUrl);
  if (!/^https?:\/\//.test(base)) throw new Error("Base URL must start with http:// or https://");
  const headers = info.api === "anthropic" ? anthropicHeaders(k) : openaiHeaders(k);
  let res: Response;
  try { res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) }); }
  catch (e) { throw new Error(`Could not reach ${whoLower(provider)} (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"})`); }
  if (res.ok) return;
  if (provider === "custom" && (res.status === 404 || res.status === 405) && model) {
    await complete({ provider, key: k, baseUrl: base, model, system: "Reply with ok.", user: "ok", maxTokens: 4 });
    return;
  }
  throw await apiError(res, who(provider));
}

export type CompleteArgs = {
  provider: Provider; key: string; baseUrl?: string; model: string;
  system: string; user: string;
  /** Ask for a JSON object. Sent as response_format where supported; always restated in the prompt by the caller. */
  json?: boolean; maxTokens?: number; temperature?: number;
};

/** One completion, returns the assistant text. Throws on transport/API errors (message is key-free). */
export async function complete(a: CompleteArgs): Promise<string> {
  const info = PROVIDERS[a.provider];
  const base = trimSlash(a.baseUrl || info.baseUrl);
  const maxTokens = a.maxTokens ?? 1500;
  const temperature = a.temperature ?? 0.2;
  if (info.api === "anthropic") {
    const res = await post(`${base}/messages`, anthropicHeaders(a.key), { model: a.model, system: a.system, max_tokens: maxTokens, temperature, messages: [{ role: "user", content: a.user }] }, a.provider);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (body.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("").trim();
  }
  const gptOss = a.model.includes("gpt-oss");
  // Newer OpenAI models reject `max_tokens` and non-default temperature; everyone else still takes them.
  const strictOpenAI = a.provider === "openai" && /^(o\d|gpt-5)/.test(a.model);
  const payload: Record<string, unknown> = {
    model: a.model,
    messages: [{ role: "system", content: a.system }, { role: "user", content: a.user }],
    ...(a.provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(strictOpenAI ? {} : { temperature }),
    ...(a.json && info.jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...(gptOss && a.provider === "groq" ? { reasoning_effort: "low" } : {}),
  };
  const res = await post(`${base}/chat/completions`, openaiHeaders(a.key), payload, a.provider);
  const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  return (body.choices?.[0]?.message?.content || "").trim();
}

async function post(url: string, headers: Record<string, string>, payload: unknown, provider: Provider): Promise<Response> {
  let res: Response;
  try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (e) { throw new Error(`Could not reach ${whoLower(provider)} (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"})`); }
  if (!res.ok) throw await apiError(res, who(provider));
  return res;
}
