#!/usr/bin/env node
// `npx arkus` — start Arkus on this machine. Creates ~/.arkus (metadata db, secret key, cloned repos),
// applies the schema, starts the prebuilt Next server bound to 127.0.0.1 on a free port, opens the browser.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (flag("--help") || flag("-h")) {
  console.log(`arkus — see your whole app and change it safely, locally.

  npx arkus              start on a free port (default 3600) and open the browser
  --port <n>             pick a port
  --no-open              don't open the browser
  --data <dir>           where Arkus keeps its own data (default ~/.arkus)
  --host 0.0.0.0         listen on all interfaces (default 127.0.0.1, this machine only)`);
  process.exit(0);
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) { console.error(`Arkus needs Node 22.5 or newer (you have ${process.versions.node}).`); process.exit(1); }

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `next` may be hoisted above the package (npx installs), so resolve it the way Node would.
let nextBin = "";
try { nextBin = createRequire(path.join(pkgDir, "package.json")).resolve("next/dist/bin/next"); } catch { /* reported below */ }
if (!fs.existsSync(path.join(pkgDir, ".next", "BUILD_ID"))) { console.error("This copy of Arkus has no production build. Run `npm run build` in the repo, or install from npm."); process.exit(1); }
if (!nextBin) { console.error("Dependencies are missing. Run `npm install` in the Arkus folder."); process.exit(1); }

const dataDir = path.resolve(opt("--data", path.join(os.homedir(), ".arkus")));
fs.mkdirSync(path.join(dataDir, "repos"), { recursive: true });
const dbFile = path.join(dataDir, "arkus.db");

// Schema: idempotent SQL generated from prisma/schema.prisma at build time.
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile);
  const sql = fs.readFileSync(path.join(pkgDir, "prisma", "schema.sql"), "utf8");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(sql);
  // Small forward migrations for databases created by earlier versions (schema.sql only adds tables).
  const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
  if (!cols("Project").includes("ownerId")) db.exec(`ALTER TABLE "Project" ADD COLUMN "ownerId" TEXT NOT NULL DEFAULT 'local'; CREATE INDEX IF NOT EXISTS "Project_ownerId_idx" ON "Project"("ownerId");`);
  if (!cols("User").includes("role")) db.exec(`ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'developer';`);
  db.close();
} catch (e) { console.error("Could not prepare the Arkus database:", e.message); process.exit(1); }

const freePort = (start) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(freePort(start + 1))); s.listen(start, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = Number(opt("--port", 0)) || await freePort(3600);
const host = opt("--host", "127.0.0.1");

const env = { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: host, DATABASE_URL: `file:${dbFile}`, ARKUS_HOME: dataDir, ARKUS_REPOS_DIR: path.join(dataDir, "repos"), NEXT_TELEMETRY_DISABLED: "1" };
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", host], { cwd: pkgDir, env, stdio: ["ignore", "pipe", "pipe"] });
const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
let opened = false;
const open = () => {
  if (opened || flag("--no-open")) return; opened = true;
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch { /* user opens it by hand */ }
};
child.stdout.on("data", (b) => { const s = b.toString(); if (/Ready|started server|Listening/i.test(s)) { console.log(`\n  Arkus is running at ${url}\n  Data: ${dataDir}\n  Stop with Ctrl+C.\n`); open(); } else if (!/^\s*$/.test(s)) process.stdout.write(s); });
child.stderr.on("data", (b) => process.stderr.write(b));
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { child.kill(sig); setTimeout(() => process.exit(0), 500); });
setTimeout(open, 6000); // fallback if the ready line is not recognised
