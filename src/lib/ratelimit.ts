// Small in-memory sliding-window rate limiter (per process). Good enough for one hosted instance;
// swap for Redis when there are several. Keys are "<bucket>:<user or ip>".
const hits = new Map<string, number[]>();
let sweep = 0;

export function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (++sweep % 500 === 0) for (const [k, arr] of hits) { const keep = arr.filter((t) => now - t < windowMs); if (keep.length) hits.set(k, keep); else hits.delete(k); }
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  return false;
}
export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local");
export const tooMany = (what = "requests") => Response.json({ error: `Too many ${what}. Try again in a few minutes.`, code: "rate_limit" }, { status: 429 });
/** Only meaningful in hosted mode; local mode never limits. */
export const limitsOn = () => process.env.ARKUS_MODE === "cloud";
