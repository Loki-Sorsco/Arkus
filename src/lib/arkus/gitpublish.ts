// Publish code changes made in Arkus. Projects cloned from a git URL (repoUrl set) get a branch
// `arkus/<slug>-<stamp>` committed from HEAD, pushed with the saved GitHub token, and a pull request
// opened through the GitHub REST API (non-GitHub remotes: branch pushed, open the MR yourself); the
// clone is then switched back to the base branch. Local folders are never published from here (mode
// "local"): a saved file is simply on disk. git always runs with `-C rootPath`, never prompts
// (GIT_TERMINAL_PROMPT=0) and never writes the token into .git/config.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/db";
import { authArgs, getGithubToken } from "./gitclone";

const exec = promisify(execFile);
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const IDENT = ["-c", "user.name=Arkus", "-c", "user.email=arkus@local"];

export type PublishMode = "local" | "pr" | "branch";
export type GitState = { isRepo: boolean; mode: PublishMode; branch: string | null; remote: string | null; remoteUrl: string | null; dirty: number; ahead?: number; reason?: string };
export type PublishResult =
  | { ok: true; mode: "pr"; branch: string; base: string; commit: string; files: string[]; prUrl: string; prNumber: number }
  | { ok: true; mode: "branch"; branch: string; base: string; commit: string; files: string[]; pushed: true; note: string }
  | { ok: false; mode: PublishMode; error: string; branch?: string; commit?: string; pushed?: boolean };

type Project = { id: string; slug: string; rootPath: string | null; repoUrl: string | null };

async function git(root: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], { timeout, env: ENV, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
const firstLine = (e: unknown) => { const err = e as { stderr?: string; message?: string }; const s = String(err.stderr || err.message || "git failed"); return s.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => /^(fatal|error|remote):/i.test(l)) || s.split("\n")[0]; };

/** Owner / repo of a github.com remote (https or ssh), or null. */
export function githubRepo(url: string | null): { owner: string; repo: string } | null {
  const m = url && /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function rootOk(rootPath: string | null): Promise<string | null> {
  if (!rootPath) return null;
  const root = path.resolve(rootPath);
  try { if (!(await fs.stat(root)).isDirectory()) return null; } catch { return null; }
  return root;
}

export async function gitState(p: Project): Promise<GitState> {
  const mode: PublishMode = !p.repoUrl ? "local" : githubRepo(p.repoUrl) ? "pr" : "branch";
  const base: GitState = { isRepo: false, mode, branch: null, remote: null, remoteUrl: null, dirty: 0 };
  const root = await rootOk(p.rootPath);
  if (!root) return { ...base, reason: "project folder not found" };
  try { await git(root, ["rev-parse", "--show-toplevel"], 15_000); } catch { return { ...base, reason: "not a git repository" }; }
  let branch: string | null = null;
  try { branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], 15_000)) || null; } catch { try { branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], 15_000); } catch { /* unborn */ } }
  const status = await git(root, ["status", "--porcelain", "-uall", "--", "."], 30_000);
  const dirty = status ? status.split("\n").filter(Boolean).length : 0;
  let remote: string | null = null, remoteUrl: string | null = null;
  try { const names = (await git(root, ["remote"], 15_000)).split("\n").filter(Boolean); remote = names.includes("origin") ? "origin" : names[0] || null; if (remote) remoteUrl = await git(root, ["remote", "get-url", remote], 15_000); } catch { /* no remotes */ }
  let ahead: number | undefined;
  try { ahead = Number(await git(root, ["rev-list", "--count", "@{u}..HEAD"], 15_000)) || 0; } catch { /* no upstream */ }
  // The remote decides the mode when the project was cloned: a GitHub clone that now points elsewhere is a plain branch push.
  const effective: PublishMode = mode === "local" ? "local" : githubRepo(remoteUrl || p.repoUrl) ? "pr" : "branch";
  return { isRepo: true, mode: effective, branch, remote, remoteUrl, dirty, ...(ahead !== undefined ? { ahead } : {}) };
}

const stamp = () => { const d = new Date(); const z = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };

async function githubDefaultBranch(owner: string, repo: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "arkus-local" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { default_branch?: string }).default_branch || null;
  } catch { return null; }
}

async function openPullRequest(owner: string, repo: string, token: string, body: { title: string; head: string; base: string; body: string }): Promise<{ url: string; number: number }> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "arkus-local" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string; errors?: { message?: string }[] };
  if (!res.ok || !data.html_url) throw new Error(`GitHub answered ${res.status}: ${data.errors?.[0]?.message || data.message || "could not open the pull request"}`);
  return { url: data.html_url, number: data.number || 0 };
}

export const NO_TOKEN = "Save a GitHub token with Contents and Pull requests write access under More → Connections → GitHub access";

/** Commit the working-tree changes on a fresh arkus/* branch, push it, open a PR (GitHub) and return to the base branch. */
export async function publish(p: Project, input: { message?: string; summaries?: string[] } = {}): Promise<PublishResult> {
  const state = await gitState(p);
  if (state.mode === "local") return { ok: false, mode: "local", error: "This project is a local folder: files are saved to disk, commit them with git when you are ready." };
  const root = await rootOk(p.rootPath);
  if (!root || !state.isRepo) return { ok: false, mode: state.mode, error: state.reason || "not a git repository" };
  if (!state.dirty) return { ok: false, mode: state.mode, error: "nothing to publish" };
  if (!state.remote || !state.remoteUrl) return { ok: false, mode: state.mode, error: "This clone has no git remote to push to." };
  const gh = state.mode === "pr" ? githubRepo(state.remoteUrl) : null;
  const token = await getGithubToken();
  if (gh && !token) return { ok: false, mode: "pr", error: NO_TOKEN };

  const message = (input.message || "").trim().slice(0, 200) || "Changes made in Arkus";
  const files = (await git(root, ["status", "--porcelain", "-uall", "--", "."], 30_000)).split("\n").filter(Boolean).map((l) => l.slice(3).trim().replace(/^"|"$/g, ""));
  const before = state.branch;
  const base = (gh && token ? await githubDefaultBranch(gh.owner, gh.repo, token) : null) || before || "main";
  const branch = `arkus/${p.slug.slice(0, 24).replace(/-+$/, "")}-${stamp()}`;

  let commit = "";
  try {
    await git(root, ["checkout", "-q", "-b", branch]);
    await git(root, ["add", "-A", "--", "."]);
    await git(root, [...IDENT, "commit", "-q", "-m", message]);
    commit = await git(root, ["rev-parse", "--short", "HEAD"]);
  } catch (e) {
    return { ok: false, mode: state.mode, error: `Could not commit: ${firstLine(e)}`, branch };
  }
  try {
    await git(root, [...authArgs(state.remoteUrl, token), "push", "-u", state.remote, branch], 180_000);
  } catch (e) {
    const line = firstLine(e);
    const hint = /could not read username|authentication failed|terminal prompts disabled|permission denied|403/i.test(line) ? (token ? " The saved GitHub token cannot push to this repository." : " No GitHub token is saved.") : "";
    return { ok: false, mode: state.mode, error: `Committed ${commit} on ${branch} but the push failed: ${line}.${hint} The branch is kept locally.`, branch, commit, pushed: false };
  }
  // The branch is safe on the remote: go back to the base branch so the next edit starts clean (branch kept locally).
  try { await git(root, ["checkout", "-q", base]); } catch { try { if (before) await git(root, ["checkout", "-q", before]); } catch { /* stay on the branch */ } }

  const log = (what: string, meta: Record<string, unknown>) => prisma.activity.create({ data: { projectId: p.id, kind: "code", what: what.slice(0, 200), meta: JSON.stringify({ branch, base, commit, files, message, ...meta }) } }).catch(() => {});
  if (!gh || !token) {
    await log(`Pushed ${files.length} file${files.length === 1 ? "" : "s"} to branch ${branch}`, { mode: "branch" });
    return { ok: true, mode: "branch", branch, base, commit, files, pushed: true, note: "Open a merge request for this branch" };
  }
  const body = ["Changes made in Arkus", "", "Files:", ...files.map((f) => `- \`${f}\``), ...(input.summaries?.length ? ["", "Changes:", ...input.summaries.slice(0, 20).map((s) => `- ${s.slice(0, 200)}`)] : [])].join("\n");
  try {
    const pr = await openPullRequest(gh.owner, gh.repo, token, { title: message, head: branch, base, body });
    await log(`Opened pull request #${pr.number} from ${branch} (${files.length} file${files.length === 1 ? "" : "s"})`, { mode: "pr", prUrl: pr.url, prNumber: pr.number });
    return { ok: true, mode: "pr", branch, base, commit, files, prUrl: pr.url, prNumber: pr.number };
  } catch (e) {
    await log(`Pushed branch ${branch}; pull request failed`, { mode: "pr", error: (e as Error).message });
    return { ok: false, mode: "pr", error: `Branch ${branch} was pushed, but opening the pull request failed: ${(e as Error).message}. Open it at https://github.com/${gh.owner}/${gh.repo}/compare/${base}...${encodeURIComponent(branch)}`, branch, commit, pushed: true };
  }
}
