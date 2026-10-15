// Clone / update a git repository for import. Never prompts (GIT_TERMINAL_PROMPT=0), never writes a
// token into .git/config: the GitHub token is passed as a one-off Authorization header. The token
// itself is stored encrypted in Arkus's Setting table (key "github.token").
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/db";
import { decrypt, encrypt, isEncrypted } from "./secrets";
import { userKey } from "../auth";

const exec = promisify(execFile);
const KEY = "github.token";
const LOGIN_KEY = "github.login";

export class CloneError extends Error {
  code: "auth" | "notfound" | "network" | "other";
  constructor(message: string, code: CloneError["code"]) { super(message); this.code = code; }
}

export async function getGithubToken(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: await userKey(KEY) } });
  if (!row?.value) return null;
  return isEncrypted(row.value) ? decrypt(row.value) : row.value;
}
export async function githubTokenInfo(): Promise<{ configured: boolean; login?: string }> {
  const [k, lk] = await Promise.all([userKey(KEY), userKey(LOGIN_KEY)]);
  const [tok, login] = await Promise.all([prisma.setting.findUnique({ where: { key: k } }), prisma.setting.findUnique({ where: { key: lk } })]);
  return { configured: Boolean(tok?.value), login: login?.value || undefined };
}
/** Check the shape and ask GitHub who the token belongs to. Nothing is stored. */
export async function verifyGithubToken(token: string): Promise<{ token: string; login: string }> {
  const t = token.trim();
  if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t)) throw new Error("That doesn't look like a GitHub token (expected ghp_… or github_pat_…)");
  const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${t}`, "User-Agent": "arkus-local", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw new Error("GitHub rejected the token (401). Check it has not expired.");
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
  const user = (await res.json()) as { login?: string };
  return { token: t, login: user.login || "github" };
}
/** Verify the token against the GitHub API, then store it encrypted. Returns the login. */
export async function setGithubToken(token: string): Promise<{ login: string }> {
  const { token: t, login } = await verifyGithubToken(token);
  const [k, lk] = await Promise.all([userKey(KEY), userKey(LOGIN_KEY)]);
  await prisma.$transaction([
    prisma.setting.upsert({ where: { key: k }, update: { value: encrypt(t) }, create: { key: k, value: encrypt(t) } }),
    prisma.setting.upsert({ where: { key: lk }, update: { value: login }, create: { key: lk, value: login } }),
  ]);
  return { login };
}
export async function clearGithubToken() {
  await prisma.setting.deleteMany({ where: { key: { in: await Promise.all([userKey(KEY), userKey(LOGIN_KEY)]) } } });
}

/** `-c http.<host>.extraheader=…` for github.com https remotes; nothing for other hosts or without a token. */
export function authArgs(url: string, token: string | null): string[] {
  if (!token) return [];
  const host = /^https:\/\/([^/]+)\//i.exec(url)?.[1]?.toLowerCase();
  if (host !== "github.com") return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

function classify(stderr: string): CloneError {
  const s = stderr.toLowerCase();
  const line = stderr.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => l.startsWith("fatal:") || l.startsWith("error:")) || stderr.split("\n")[0] || "git failed";
  if (/could not read username|authentication failed|terminal prompts disabled|invalid username or password|permission denied|403/.test(s)) return new CloneError(line, "auth");
  if (/repository not found|not found|does not exist|404/.test(s)) return new CloneError(line, "notfound");
  if (/could not resolve host|connection|timed out|network|unable to access/.test(s)) return new CloneError(line, "network");
  return new CloneError(line, "other");
}

/** Shallow-clone `url` into `dest` (or fast-forward it if it already exists). */
export async function cloneOrPull(url: string, dest: string, exists: boolean, token?: string | null): Promise<void> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  const tok = token === undefined ? await getGithubToken() : token;
  const auth = authArgs(url, tok);
  try {
    if (exists) await exec("git", [...auth, "-C", dest, "pull", "--ff-only"], { timeout: 120000, env });
    else await exec("git", [...auth, "clone", "--depth", "1", url, dest], { timeout: 300000, env });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw classify(String(err.stderr || err.message || ""));
  }
}

export function friendlyCloneMessage(e: CloneError, hasToken: boolean): string {
  if (e.code === "auth") return hasToken ? `GitHub refused the saved token for this repository (${e.message}). Make sure the token can read the repo, or save a new one.` : "This repository is private. Turn on Private repository, paste a GitHub token with read access to the repo, and try again.";
  if (e.code === "notfound") return "GitHub says that repository does not exist. Check the URL, or save a token if it is private.";
  if (e.code === "network") return `Couldn't reach the git host: ${e.message}`;
  return `Clone failed: ${e.message}`;
}
