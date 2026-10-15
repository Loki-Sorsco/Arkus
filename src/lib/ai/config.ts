// Which AI the current user runs on. Two sources: the server's *included* key (env, for the hosted
// version / subscriptions / a dev .env) and a *bring-your-own* key the user saved in Settings
// (encrypted in Arkus's own Setting table, per user in cloud mode). Resolution is cached 30 s per
// user so route handlers don't hit the DB on every call. Keys never leave this module unmasked
// except to the provider transport.
import { userKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { decrypt, encrypt, isEncrypted } from "@/lib/arkus/secrets";
import { isProvider, PROVIDERS, type Provider } from "./providers";

export type AiMode = "included" | "byok" | "off";
export type AiConfig = { mode: AiMode; provider?: Provider; key?: string; model?: string; baseUrl?: string };
export type Resolved = { source: "included" | "byok"; provider: Provider; key: string; baseUrl?: string; model: string; fastModel: string };

const SETTING = "ai.config";
const LEGACY = "ai.groqKey"; // pre-provider Arkus stored a bare Groq key here
const TTL = 30_000;
const cache = new Map<string, { cfg: AiConfig; at: number }>();

/** The server's included key, from env. `null` when this Arkus has none. */
export function includedConfig(): Resolved | null {
  const p = (process.env.ARKUS_AI_PROVIDER || "groq").trim();
  const provider: Provider = isProvider(p) ? p : "groq";
  const key = (process.env.ARKUS_AI_KEY || (provider === "groq" ? process.env.GROQ_API_KEY : "") || "").trim();
  if (!key) return null;
  const d = PROVIDERS[provider];
  return {
    source: "included", provider, key,
    baseUrl: process.env.ARKUS_AI_BASE_URL?.trim() || undefined,
    model: process.env.ARKUS_AI_MODEL || (provider === "groq" ? process.env.GROQ_MODEL : "") || d.model,
    fastModel: process.env.ARKUS_AI_FAST_MODEL || (provider === "groq" ? process.env.GROQ_FAST_MODEL : "") || d.fastModel,
  };
}

function readValue(v: string | null | undefined): string | null {
  if (!v) return null;
  try { return isEncrypted(v) ? decrypt(v) : v; } catch { return null; }
}

/** The user's saved choice; `{ mode: "included" }` when nothing was saved. Migrates the old Groq-only setting. */
export async function loadConfig(force = false): Promise<AiConfig> {
  const sk = await userKey(SETTING);
  const hit = cache.get(sk);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.cfg;
  let cfg: AiConfig = { mode: "included" };
  try {
    const row = await prisma.setting.findUnique({ where: { key: sk } });
    const raw = readValue(row?.value);
    if (raw) {
      const parsed = JSON.parse(raw) as AiConfig;
      if (parsed && ["included", "byok", "off"].includes(parsed.mode)) cfg = parsed;
    } else {
      const legacy = await prisma.setting.findUnique({ where: { key: await userKey(LEGACY) } });
      const key = readValue(legacy?.value);
      if (key) cfg = { mode: "byok", provider: "groq", key };
    }
  } catch { /* settings table unavailable: behave as "included" */ }
  if (cfg.mode === "byok" && (!isProvider(cfg.provider) || (!cfg.key && !PROVIDERS[cfg.provider].keyOptional))) cfg = { mode: "included" };
  cache.set(sk, { cfg, at: Date.now() });
  return cfg;
}

export async function saveConfig(cfg: AiConfig): Promise<void> {
  const sk = await userKey(SETTING);
  const value = encrypt(JSON.stringify(cfg));
  await prisma.setting.upsert({ where: { key: sk }, update: { value }, create: { key: sk, value } });
  await prisma.setting.deleteMany({ where: { key: await userKey(LEGACY) } }).catch(() => {});
  cache.delete(sk);
}

/** Forget the saved choice: back to the included key (or nothing, if the server has none). */
export async function resetConfig(): Promise<void> {
  const sk = await userKey(SETTING);
  await prisma.setting.deleteMany({ where: { key: { in: [sk, await userKey(LEGACY)] } } });
  cache.delete(sk);
}

/** What to call right now: byok with a key → that; included (or unset) → the server key; off → null. */
export async function resolve(force = false): Promise<Resolved | null> {
  const cfg = await loadConfig(force);
  if (cfg.mode === "off") return null;
  if (cfg.mode === "byok" && cfg.provider) {
    const d = PROVIDERS[cfg.provider];
    return { source: "byok", provider: cfg.provider, key: cfg.key || "", baseUrl: cfg.baseUrl || undefined, model: cfg.model || d.model, fastModel: cfg.model || d.fastModel };
  }
  return includedConfig();
}

/** Last 4 characters behind dots, for the Settings UI. Never the key itself. */
export const maskKey = (key: string | undefined) => (key ? `••••${key.slice(-4)}` : null);
