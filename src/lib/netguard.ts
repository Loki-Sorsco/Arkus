// Outbound-request guard for hosted mode: the server sends requests on behalf of users (Test tab,
// Live API probes, database connections), so targets must not be the server itself or its private
// network. Local mode (npx arkus) allows everything: it is the user's own machine.
import dns from "node:dns/promises";
import net from "node:net";

const allowPrivate = () => process.env.ARKUS_MODE !== "cloud" || process.env.ARKUS_ALLOW_PRIVATE_TARGETS === "true";

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80")) return true;
    const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (m4) return isPrivateIp(m4[1]);
  }
  return false;
}

/** Throws a user-facing error when `host` must not be contacted from this server. */
export async function assertPublicHost(host: string, what = "address"): Promise<void> {
  if (allowPrivate()) return;
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "db" || h === "arkus" || h === "metadata.google.internal") throw new NetGuardError(`Hosted Arkus cannot reach "${host}". Use a public ${what}.`);
  if (net.isIP(h)) { if (isPrivateIp(h)) throw new NetGuardError(`Hosted Arkus cannot reach private ${what} ${host}.`); return; }
  let addrs: { address: string }[] = [];
  try { addrs = await dns.lookup(h, { all: true }); } catch { throw new NetGuardError(`Could not resolve ${host}.`); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new NetGuardError(`Hosted Arkus cannot reach "${host}": it points at a private network.`);
}
export class NetGuardError extends Error { status = 400; }
