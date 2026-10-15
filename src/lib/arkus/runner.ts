// Run the user's app on their own machine so Live can show it. One child process per project, kept
// in a map that survives hot reloads; its output goes to a 200-line ring buffer and the first
// localhost URL it prints becomes the Dev base URL. Refused outright in cloud mode: Arkus never runs
// someone else's code on a shared host.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCloud } from "@/lib/auth";

export type RunProject = { id: string; rootPath: string | null };
export type AppStatus = { running: boolean; pid?: number; url?: string; command?: string; startedAt?: string; exitCode?: number | null; log: string[] };
type Proc = { child: ChildProcess; pid: number; command: string; startedAt: string; url?: string; log: string[]; exitCode?: number | null; exited: boolean };

export const CLOUD_MSG = "Run app is only available on your own machine";
const LOG_LINES = 200;
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)/;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const WIN = process.platform === "win32";

// Survives Next's dev-mode module reloads, so a started app is not orphaned by an edit.
const g = globalThis as unknown as { __arkusRunner?: Map<string, Proc> };
const procs: Map<string, Proc> = (g.__arkusRunner ||= new Map());

/** How to start the app in `root`: npm scripts first, then Django, then FastAPI. Small and explicit. */
export function detectCommand(root: string): string | null {
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts || {};
      if (scripts.dev) return "npm run dev";
      if (scripts.start) return "npm run start";
    } catch { /* unreadable package.json: fall through */ }
  }
  if (existsSync(join(root, "manage.py"))) return "python manage.py runserver 0.0.0.0:8000";
  for (const f of ["main.py", "app.py"]) {
    const p = join(root, f);
    if (existsSync(p) && /FastAPI\s*\(/.test(readFileSync(p, "utf8"))) return `uvicorn ${f.replace(/\.py$/, "")}:app --port 8000`;
  }
  return null;
}

const childEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {};
  // Let the app pick its own port and keep Arkus's own Next/Turbopack settings out of its way.
  for (const [k, v] of Object.entries(process.env)) if (k !== "PORT" && k !== "NODE_ENV" && !/^(__NEXT|NEXT_RUNTIME|NEXT_DEPLOYMENT_ID|TURBOPACK|NODE_OPTIONS)/.test(k)) env[k] = v;
  env.FORCE_COLOR = "0"; env.NO_COLOR = "1"; env.BROWSER = "none"; env.CI = env.CI || "1";
  return env;
};

export function startApp(project: RunProject, opts: { onUrl?: (url: string) => void | Promise<void> } = {}): AppStatus {
  if (isCloud()) throw new RunError(CLOUD_MSG);
  if (!project.rootPath) throw new RunError("This project has no local folder to run");
  const cur = procs.get(project.id);
  if (cur && !cur.exited) return appStatus(project);
  const root = project.rootPath;
  if (!existsSync(root)) throw new RunError(`Folder not found: ${root}`);
  const command = detectCommand(root);
  if (!command) throw new RunError("Could not work out how to start this app (no package.json dev/start script, manage.py or FastAPI main.py)");

  const spawnOpts: SpawnOptions = { cwd: root, shell: true, env: childEnv() as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: !WIN, windowsHide: true };
  const child: ChildProcess = spawn(command, spawnOpts);
  const proc: Proc = { child, pid: child.pid || 0, command, startedAt: new Date().toISOString(), log: [], exited: false };
  procs.set(project.id, proc);
  const push = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      const line = raw.replace(ANSI_RE, "").trimEnd();
      if (!line) continue;
      proc.log.push(line);
      if (proc.log.length > LOG_LINES) proc.log.splice(0, proc.log.length - LOG_LINES);
      if (!proc.url) { const m = URL_RE.exec(line); if (m) { proc.url = m[1].replace("0.0.0.0", "localhost").replace("127.0.0.1", "localhost"); void Promise.resolve(opts.onUrl?.(proc.url)).catch(() => {}); } }
    }
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("error", (e) => { proc.log.push(`[arkus] could not start: ${e.message}`); proc.exited = true; proc.exitCode = -1; });
  child.on("exit", (code, signal) => { proc.exited = true; proc.exitCode = code; proc.log.push(`[arkus] exited${code != null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}`); });
  return appStatus(project);
}

export async function stopApp(project: RunProject): Promise<AppStatus> {
  if (isCloud()) throw new RunError(CLOUD_MSG);
  const proc = procs.get(project.id);
  if (!proc) return appStatus(project);
  if (!proc.exited) {
    await killTree(proc);
    await waitExit(proc, 5000);
    if (!proc.exited) { try { proc.child.kill("SIGKILL"); } catch { /* already gone */ } await waitExit(proc, 1000); }
  }
  procs.delete(project.id);
  return { running: false, log: proc.log.slice(-40) };
}

export function appStatus(project: RunProject): AppStatus {
  if (isCloud()) throw new RunError(CLOUD_MSG);
  const proc = procs.get(project.id);
  if (!proc) return { running: false, log: [] };
  return { running: !proc.exited, pid: proc.pid || undefined, url: proc.url, command: proc.command, startedAt: proc.startedAt, exitCode: proc.exited ? proc.exitCode ?? null : undefined, log: proc.log.slice() };
}

export class RunError extends Error { status = 400; }

function killTree(proc: Proc): Promise<void> {
  return new Promise((resolve) => {
    if (WIN) { execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => resolve()); return; }
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.child.kill("SIGTERM"); } catch { /* gone */ } }
    resolve();
  });
}
function waitExit(proc: Proc, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exited) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); proc.child.off("exit", done); resolve(); }
    proc.child.once("exit", done);
  });
}
