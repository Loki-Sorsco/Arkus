// Connections to the user's own database. One small uniform driver interface over
// pg (postgres), mysql2 (mysql) and the Node 24 built-in node:sqlite (sqlite).
// RULE: connections are read-only unless opened with { writable: true } (only mutate.ts does that).
// Read-only: Postgres queries run inside BEGIN READ ONLY with statement/lock timeouts; mysql sessions
// are SET TRANSACTION READ ONLY with MAX_EXECUTION_TIME; sqlite files are opened { readOnly: true }.
// Writable: same timeouts, no READ ONLY flag, and `rowCount` / `lastInsertId` are filled for
// INSERT / UPDATE / DELETE. Passwords are never logged or returned.
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";

export type Engine = "postgres" | "mysql" | "sqlite";
export interface DbConfig { engine?: Engine; url: string; schemaOnly?: boolean }

export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  ms: number;
  /** Rows returned by a SELECT, or rows affected by INSERT / UPDATE / DELETE (writable connections). */
  rowCount?: number;
  /** Auto-generated key of the last INSERT when the driver reports one (sqlite rowid, mysql insertId). */
  lastInsertId?: number | string;
}
export interface OpenOpts { writable?: boolean }
export interface DbConn {
  engine: Engine;
  /** True when opened with { writable: true }; read-only connections refuse / cannot write. */
  writable: boolean;
  /** Display string with the password redacted, e.g. "postgres://app@db.local:5432/shop". */
  display: string;
  /** Placeholder for the i-th (1-based) bound parameter: $1 (pg) · ? (mysql/sqlite). */
  param(i: number): string;
  /** Quote an identifier per engine. */
  quoteId(name: string): string;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

export interface ParsedUrl {
  engine: Engine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  file?: string;          // sqlite path (as written in the url)
  display: string;        // never contains the password
  hasPassword: boolean;
}

// ---------------------------------------------------------------- url parsing / redaction

export function parseDbUrl(url: string, engineHint?: Engine): ParsedUrl {
  const u = url.trim();
  const low = u.toLowerCase();
  const sqliteLike = low.startsWith("file:") || low.startsWith("sqlite:") || /\.(db|sqlite|sqlite3)(\?.*)?$/.test(low) || (!/^[a-z+]+:\/\//.test(low) && !low.includes("://"));
  if (engineHint === "sqlite" || (sqliteLike && engineHint !== "postgres" && engineHint !== "mysql")) {
    let file = u.replace(/^sqlite:\/\/\/?/i, "").replace(/^sqlite:/i, "").replace(/^file:\/\/\/?/i, "").replace(/^file:/i, "");
    file = file.split("?")[0];
    return { engine: "sqlite", file, display: `sqlite:${file}`, hasPassword: false };
  }
  const m = /^([a-z0-9+]+):\/\/(?:([^:@/]*)(?::([^@]*))?@)?([^/?#:]*|\[[^\]]*\])(?::(\d+))?(?:\/([^?#]*))?/i.exec(u);
  if (!m) throw new Error("Unrecognized database URL. Use postgres://user:pass@host:5432/db, mysql://… or file:./dev.db");
  const scheme = m[1].toLowerCase();
  const engine: Engine = engineHint ?? (scheme.startsWith("mysql") || scheme.startsWith("maria") ? "mysql" : "postgres");
  const user = m[2] ? safeDecode(m[2]) : undefined;
  const host = m[4] || "localhost";
  const port = m[5] ? Number(m[5]) : engine === "mysql" ? 3306 : 5432;
  const database = m[6] ? safeDecode(m[6]) : undefined;
  const display = `${engine}://${user ? user + "@" : ""}${host}:${port}${database ? "/" + database : ""}`;
  return { engine, host, port, database, user, display, hasPassword: Boolean(m[3]) };
}
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Strip any password that might appear in an error message or URL. */
export function redact(text: string, url?: string): string {
  let out = String(text ?? "");
  if (url) {
    const m = /^[a-z0-9+]+:\/\/[^:@/]*:([^@]*)@/i.exec(url.trim());
    if (m && m[1]) out = out.split(m[1]).join("•••");
    const pw = /password=([^&\s]+)/i.exec(url);
    if (pw && pw[1]) out = out.split(pw[1]).join("•••");
  }
  return out.replace(/(:\/\/[^:@/\s]*:)[^@\s]*@/g, "$1•••@").replace(/(password\s*[=:]\s*)[^&\s'"]+/gi, "$1•••");
}

// ---------------------------------------------------------------- ssrf / locality
// Arkus is local-first: the user's own database usually lives on localhost, a LAN host or a
// docker network, so private / link-local / metadata ranges are ALLOWED on purpose. We still
// detect them so the result carries `local: true` and the UI can label the connection; a hosted
// deployment of Arkus should flip `ALLOW_PRIVATE_DB_HOSTS` to "0" to refuse them.
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("::ffff:");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}
const privateAllowed = () => process.env.ALLOW_PRIVATE_DB_HOSTS !== "0";

// ---------------------------------------------------------------- drivers

const PG_PREAMBLE = ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '15s'", "SET LOCAL lock_timeout = '2s'"];
const PG_PREAMBLE_RW = ["BEGIN", "SET LOCAL statement_timeout = '15s'", "SET LOCAL lock_timeout = '2s'"];

async function openPostgres(url: string, parsed: ParsedUrl, writable = false): Promise<DbConn> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 8000, application_name: writable ? "arkus-write" : "arkus-readonly" });
  await client.connect();
  const quoteId = (n: string) => '"' + n.replace(/"/g, '""') + '"';
  return {
    engine: "postgres", writable, display: parsed.display, param: i => `$${i}`, quoteId,
    async query(sql, params = []) {
      const t0 = Date.now();
      try {
        for (const s of writable ? PG_PREAMBLE_RW : PG_PREAMBLE) await client.query(s);
        const res = await client.query({ text: sql, values: params as unknown[] });
        await client.query("COMMIT");
        return { rows: res.rows as Record<string, unknown>[], fields: (res.fields ?? []).map(f => f.name), ms: Date.now() - t0, rowCount: res.rowCount ?? res.rows.length };
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw new Error(redact((e as Error).message, url));
      }
    },
    async close() { await client.end().catch(() => undefined); },
  };
}

async function openMysql(url: string, parsed: ParsedUrl, writable = false): Promise<DbConn> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 8000, rowsAsArray: false, decimalNumbers: true });
  if (!writable) await conn.query("SET SESSION TRANSACTION READ ONLY");
  // MySQL 5.7.8+ uses MAX_EXECUTION_TIME (ms); MariaDB uses max_statement_time (s). Try both, ignore the miss.
  try { await conn.query("SET SESSION MAX_EXECUTION_TIME = 15000"); }
  catch { try { await conn.query("SET SESSION max_statement_time = 15"); } catch { /* unsupported server; rely on hint */ } }
  const quoteId = (n: string) => "`" + n.replace(/`/g, "``") + "`";
  return {
    engine: "mysql", writable, display: parsed.display, param: () => "?", quoteId,
    async query(sql, params = []) {
      const t0 = Date.now();
      try {
        const hinted = /^\s*select\b/i.test(sql) ? sql.replace(/^\s*select\b/i, "SELECT /*+ MAX_EXECUTION_TIME(15000) */") : sql;
        const [rows, fields] = await conn.query(hinted, params as unknown[]);
        const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        const names = Array.isArray(fields) ? (fields as { name: string }[]).map(f => f.name) : Object.keys(list[0] ?? {});
        // Non-SELECT statements come back as an OkPacket { affectedRows, insertId } instead of rows.
        const ok = !Array.isArray(rows) && rows && typeof rows === "object" ? (rows as { affectedRows?: number; insertId?: number }) : null;
        return { rows: list, fields: names, ms: Date.now() - t0, rowCount: ok ? ok.affectedRows ?? 0 : list.length, lastInsertId: ok && ok.insertId ? ok.insertId : undefined };
      } catch (e) { throw new Error(redact((e as Error).message, url)); }
    },
    async close() { await conn.end().catch(() => undefined); },
  };
}

export function resolveSqlitePath(file: string, baseDir?: string): string {
  if (file === ":memory:") return file;
  return path.isAbsolute(file) ? file : path.resolve(baseDir ?? process.cwd(), file);
}

const SQLITE_READ_RE = /^\s*(?:select|with|values|explain|pragma)\b/i;

async function openSqlite(parsed: ParsedUrl, baseDir?: string, writable = false): Promise<DbConn> {
  const { DatabaseSync } = await import("node:sqlite");
  const file = resolveSqlitePath(parsed.file ?? "", baseDir);
  if (!fs.existsSync(file)) throw new Error(`SQLite file not found: ${file}`);
  const db = new DatabaseSync(file, { readOnly: !writable });
  if (writable) { try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* older node */ } }
  const quoteId = (n: string) => '"' + n.replace(/"/g, '""') + '"';
  return {
    engine: "sqlite", writable, display: `sqlite:${file}`, param: () => "?", quoteId,
    async query(sql, params = []) {
      const t0 = Date.now();
      const stmt = db.prepare(sql);
      const norm = params.map(p => (typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p)) as (null | number | bigint | string | Uint8Array)[];
      if (writable && !SQLITE_READ_RE.test(sql)) {
        // Statements that return no result set go through .run() so we get `changes` / `lastInsertRowid`.
        const r = stmt.run(...norm);
        const last = typeof r.lastInsertRowid === "bigint" ? Number(r.lastInsertRowid) : r.lastInsertRowid;
        return { rows: [], fields: [], ms: Date.now() - t0, rowCount: Number(r.changes), lastInsertId: last ? Number(last) : undefined };
      }
      const rows = stmt.all(...norm).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
      const fields = typeof stmt.columns === "function" ? stmt.columns().map(c => c.name) : Object.keys(rows[0] ?? {});
      return { rows, fields, ms: Date.now() - t0, rowCount: rows.length };
    },
    async close() { db.close(); },
  };
}

export async function openConnection(config: DbConfig, baseDir?: string, opts: OpenOpts = {}): Promise<DbConn> {
  const parsed = parseDbUrl(config.url, config.engine);
  const writable = Boolean(opts.writable);
  if (parsed.engine === "sqlite") return openSqlite(parsed, baseDir, writable);
  if (parsed.engine === "mysql") return openMysql(config.url, parsed, writable);
  return openPostgres(config.url, parsed, writable);
}

// ---------------------------------------------------------------- staged connection test

export interface TestStage { name: string; ok: boolean; ms: number; error?: string }
export interface TestResult { ok: boolean; engine: Engine; display: string; local?: boolean; stages: TestStage[]; tableCount?: number; version?: string }

export async function testConnection(config: DbConfig, baseDir?: string): Promise<TestResult> {
  const stages: TestStage[] = [];
  let parsed: ParsedUrl;
  try { parsed = parseDbUrl(config.url, config.engine); }
  catch (e) { return { ok: false, engine: config.engine ?? "postgres", display: "", stages: [{ name: "Parse", ok: false, ms: 0, error: (e as Error).message }] }; }
  const result: TestResult = { ok: false, engine: parsed.engine, display: parsed.display, stages };
  const run = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    try { await fn(); stages.push({ name, ok: true, ms: Date.now() - t0 }); return true; }
    catch (e) { stages.push({ name, ok: false, ms: Date.now() - t0, error: redact((e as Error).message, config.url) }); return false; }
  };
  let conn: DbConn | undefined;
  try {
    if (parsed.engine === "sqlite") {
      const file = resolveSqlitePath(parsed.file ?? "", baseDir);
      result.local = true;
      if (!(await run("File", async () => { fs.accessSync(file, fs.constants.R_OK); }))) return result;
      if (!(await run("Open", async () => { conn = await openSqlite(parsed, baseDir); }))) return result;
    } else {
      if (!(await run("DNS", async () => {
        const host = parsed.host!.replace(/^\[|\]$/g, "");
        const ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
        if (isPrivateIp(ip)) {
          result.local = true;
          if (!privateAllowed()) throw new Error(`host resolves to private address ${ip}; blocked by ALLOW_PRIVATE_DB_HOSTS=0`);
        }
      }))) return result;
      if (!(await run("TCP", () => new Promise<void>((res, rej) => {
        const s = net.connect({ host: parsed.host!.replace(/^\[|\]$/g, ""), port: parsed.port!, timeout: 5000 });
        s.once("connect", () => { s.destroy(); res(); });
        s.once("timeout", () => { s.destroy(); rej(new Error("connect timeout (5s)")); });
        s.once("error", e => rej(e));
      })))) return result;
      if (!(await run("Auth", async () => { conn = await openConnection(config, baseDir); await conn.query("SELECT 1 AS ok"); }))) return result;
    }
    const ok = await run("Introspect", async () => {
      const c = conn!;
      const q = c.engine === "postgres"
        ? "SELECT count(*)::int AS n, (SELECT version()) AS v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'"
        : c.engine === "mysql"
          ? "SELECT COUNT(*) AS n, VERSION() AS v FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
          : "SELECT count(*) AS n, sqlite_version() AS v FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
      const r = await c.query(q);
      result.tableCount = Number(r.rows[0]?.n ?? 0);
      result.version = String(r.rows[0]?.v ?? "").slice(0, 80);
    });
    result.ok = ok;
    return result;
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- project helper

export interface ProjectConn { conn: DbConn; config: DbConfig; sourceId: string; schemaOnly: boolean }

/** Load the env's db Source for a project and open a connection to it (read-only unless opts.writable). */
export async function connForProject(projectId: string, env = "dev", opts: OpenOpts = {}): Promise<ProjectConn> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("project not found");
  const source = await prisma.source.findFirst({ where: { projectId, kind: "db", env }, orderBy: { createdAt: "desc" } });
  if (!source) throw new Error(`no database connected for env "${env}"`);
  const { readDbConfig } = await import("./dbsources");
  const config: DbConfig = await readDbConfig(source);
  const conn = await openConnection(config, project.rootPath ?? undefined, opts);
  return { conn, config, sourceId: source.id, schemaOnly: Boolean(config.schemaOnly) };
}
