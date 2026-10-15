// Lifecycle of a project's database Sources: encrypted config, public (safe) shape, upsert
// (test -> save -> introspect -> snapshot -> activity), re-test, re-sync with diff, removal.
// RULE: the connection url never leaves this module in plaintext except into dbconn's drivers.
import { prisma, j } from "@/lib/db";
import { assertPublicHost } from "@/lib/netguard";
import { isCloud } from "../auth";
import { openConnection, parseDbUrl, redact, testConnection, type DbConfig, type Engine, type TestResult } from "./dbconn";
import { introspect } from "./introspect";
import { loadSchemaSnapshotTables, persistSchemaSnapshot, type SchemaSnapshotInfo } from "./schemastore";
import { diffSchemas, type SchemaDiff } from "./schemadiff";
import { decrypt, encrypt, isEncrypted } from "./secrets";

type SourceRow = { id: string; projectId: string; kind: string; env: string; name: string; config: string; status: string; lastError: string | null; testedAt: Date | null; createdAt: Date };

/** Stored shape of Source.config for kind "db". `url` is the legacy plaintext field (upgraded on read). */
export interface DbSourceConfig {
  engine?: Engine; urlEnc?: string; url?: string; display?: string; schemaOnly?: boolean;
  host?: string; port?: number; database?: string; user?: string; file?: string; local?: boolean;
}
export interface PublicSnapshot { id: string; version: string; createdAt: Date; stats: Record<string, unknown> }
export interface PublicSource {
  id: string; name: string; env: string; kind: string; engine: Engine | null; display: string; schemaOnly: boolean;
  status: string; testedAt: Date | null; lastError: string | null; local: boolean; database?: string; host?: string;
  snapshot: PublicSnapshot | null;
}

export const ENVS = ["dev", "preview", "prod"] as const;
export const isEnv = (e: unknown): e is (typeof ENVS)[number] => typeof e === "string" && (ENVS as readonly string[]).includes(e);

function buildConfig(engine: Engine | undefined, url: string, schemaOnly: boolean, local?: boolean): { config: DbSourceConfig; engine: Engine; display: string } {
  const p = parseDbUrl(url, engine);
  if (isCloud() && p.engine === "sqlite") throw new Error("SQLite files on the server are not available in hosted Arkus. Connect a Postgres or MySQL database instead.");
  const config: DbSourceConfig = { engine: p.engine, urlEnc: encrypt(url), display: p.display, schemaOnly, host: p.host, port: p.port, database: p.database, user: p.user, file: p.file, local };
  return { config, engine: p.engine, display: p.display };
}

/** Decrypt the stored config. Legacy plain `url` is transparently re-saved as `urlEnc`. */
export async function readDbConfig(source: Pick<SourceRow, "id" | "config">): Promise<{ engine: Engine; url: string; schemaOnly: boolean }> {
  const cfg = j<DbSourceConfig>(source.config, {});
  if (typeof cfg.url === "string" && cfg.url && !cfg.urlEnc) {
    const { config } = buildConfig(cfg.engine, cfg.url, Boolean(cfg.schemaOnly), cfg.local);
    await prisma.source.update({ where: { id: source.id }, data: { config: JSON.stringify(config) } });
    return { engine: config.engine!, url: cfg.url, schemaOnly: Boolean(cfg.schemaOnly) };
  }
  if (!cfg.urlEnc || !isEncrypted(cfg.urlEnc)) throw new Error("database source has no connection string - reconnect it");
  const url = decrypt(cfg.urlEnc);
  const engine = cfg.engine ?? parseDbUrl(url).engine;
  return { engine, url, schemaOnly: Boolean(cfg.schemaOnly) };
}

/** Safe shape for the UI. Never contains url / urlEnc. */
export function publicSource(source: SourceRow, latestSnapshot?: { id: string; version: string; createdAt: Date; stats: string } | null): PublicSource {
  const cfg = j<DbSourceConfig>(source.config, {});
  let display = cfg.display ?? "", engine = cfg.engine ?? null;
  if (!display && typeof cfg.url === "string" && cfg.url) { try { const p = parseDbUrl(cfg.url, cfg.engine); display = p.display; engine = p.engine; } catch { /* keep */ } }
  return {
    id: source.id, name: source.name, env: source.env, kind: source.kind, engine, display, schemaOnly: Boolean(cfg.schemaOnly),
    status: source.status, testedAt: source.testedAt, lastError: source.lastError ? redact(source.lastError) : null, local: Boolean(cfg.local),
    database: cfg.database ?? (cfg.file ? cfg.file.split(/[\\/]/).pop() : undefined), host: cfg.host,
    snapshot: latestSnapshot ? { id: latestSnapshot.id, version: latestSnapshot.version, createdAt: latestSnapshot.createdAt, stats: j(latestSnapshot.stats, {}) } : null,
  };
}

export async function latestSchemaSnapshot(projectId: string, sourceId: string) {
  return prisma.snapshot.findFirst({ where: { projectId, sourceId, kind: "schema", status: "ready" }, orderBy: { createdAt: "desc" }, select: { id: true, version: true, createdAt: true, stats: true } });
}

/** All db sources of a project in their public shape (one per env at most). */
export async function listDbSources(projectId: string): Promise<PublicSource[]> {
  const rows = await prisma.source.findMany({ where: { projectId, kind: "db" }, orderBy: { createdAt: "desc" } });
  const out: PublicSource[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.env)) continue; seen.add(r.env);
    out.push(publicSource(r, await latestSchemaSnapshot(projectId, r.id)));
  }
  const order = (e: string) => ENVS.indexOf(e as (typeof ENVS)[number]);
  return out.sort((a, b) => order(a.env) - order(b.env));
}

async function projectRoot(projectId: string): Promise<string | undefined> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { rootPath: true } });
  return p?.rootPath ?? undefined;
}

export interface UpsertResult { ok: boolean; source: PublicSource; snapshot: (SchemaSnapshotInfo & { id: string }) | null; test: TestResult; error?: string }

/** Test -> save encrypted -> introspect -> persist snapshot -> Activity "connect". Replaces the env's previous source. */
export async function upsertDbSource(input: { projectId: string; env: string; engine?: Engine; url: string; schemaOnly?: boolean; name?: string }): Promise<UpsertResult> {
  const { projectId, env } = input;
  const baseDir = await projectRoot(projectId);
  const dbConfig: DbConfig = { engine: input.engine, url: input.url, schemaOnly: Boolean(input.schemaOnly) };
  const parsed = parseDbUrl(input.url, input.engine);   // throws on garbage urls
  dbConfig.engine = parsed.engine;
  const name = (input.name || "").trim().slice(0, 80) || parsed.database || parsed.file?.split(/[\\/]/).pop() || `${parsed.engine} ${env}`;
  if (parsed.host) await assertPublicHost(parsed.host, "database host");
  const test = await testConnection(dbConfig, baseDir);
  const { config } = buildConfig(parsed.engine, input.url, Boolean(input.schemaOnly), test.local);

  const existing = await prisma.source.findMany({ where: { projectId, kind: "db", env }, orderBy: { createdAt: "desc" } });
  const data = { name, config: JSON.stringify(config), status: test.ok ? "ok" : "error", lastError: test.ok ? null : redact(test.stages.find(s => !s.ok)?.error ?? "connection failed", input.url), testedAt: new Date() };
  let source: SourceRow;
  if (existing.length) {
    // Keep the newest row (its snapshot history stays attached), drop any stray duplicates.
    source = await prisma.source.update({ where: { id: existing[0].id }, data });
    for (const dup of existing.slice(1)) await removeSource(dup.id);
  } else {
    source = await prisma.source.create({ data: { projectId, kind: "db", env, ...data } });
  }
  if (!test.ok) return { ok: false, source: publicSource(source, await latestSchemaSnapshot(projectId, source.id)), snapshot: null, test };

  let conn;
  try {
    conn = await openConnection(dbConfig, baseDir);
    const result = await introspect(conn);
    const snap = await persistSchemaSnapshot(projectId, source.id, result);
    await prisma.activity.create({ data: { projectId, env, kind: "connect", what: `Connected ${parsed.engine} database "${name}" (${result.stats.tables} tables)`, meta: JSON.stringify({ sourceId: source.id, snapshotId: snap.snapshotId, version: snap.version, engine: parsed.engine, display: parsed.display, stats: snap.stats }) } });
    const fresh = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });
    return { ok: true, source: publicSource(fresh, await latestSchemaSnapshot(projectId, source.id)), snapshot: { ...snap, id: snap.snapshotId }, test };
  } catch (e) {
    const msg = redact((e as Error).message, input.url);
    const errored = await prisma.source.update({ where: { id: source.id }, data: { status: "error", lastError: `introspect: ${msg}` } });
    return { ok: false, source: publicSource(errored, await latestSchemaSnapshot(projectId, source.id)), snapshot: null, test, error: msg };
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

/** Decrypt, run the staged test, update status/testedAt/lastError. */
export async function testStoredSource(sourceId: string): Promise<{ source: PublicSource; test: TestResult }> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  if (source.kind !== "db") throw new Error("not a database source");
  let test: TestResult;
  try {
    const cfg = await readDbConfig(source);
    test = await testConnection(cfg, await projectRoot(source.projectId));
  } catch (e) {
    test = { ok: false, engine: (j<DbSourceConfig>(source.config, {}).engine ?? "postgres"), display: "", stages: [{ name: "Config", ok: false, ms: 0, error: redact((e as Error).message) }] };
  }
  const updated = await prisma.source.update({ where: { id: sourceId }, data: { status: test.ok ? "ok" : "error", testedAt: new Date(), lastError: test.ok ? null : redact(test.stages.find(s => !s.ok)?.error ?? "connection failed") } });
  return { source: publicSource(updated, await latestSchemaSnapshot(source.projectId, sourceId)), test };
}

/** Re-introspect -> new schema snapshot (deduped by version) -> diff against the previous one. */
export async function syncSource(sourceId: string): Promise<{ source: PublicSource; snapshot: SchemaSnapshotInfo & { id: string }; diff: SchemaDiff; reused: boolean; previousSnapshotId: string | null }> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  if (source.kind !== "db") throw new Error("not a database source");
  const cfg = await readDbConfig(source);
  const baseDir = await projectRoot(source.projectId);
  const previous = await latestSchemaSnapshot(source.projectId, sourceId);
  const before = previous ? await loadSchemaSnapshotTables(previous.id) : [];
  let conn;
  try {
    conn = await openConnection(cfg, baseDir);
    const result = await introspect(conn);
    const snap = await persistSchemaSnapshot(source.projectId, sourceId, result);
    const diff = diffSchemas(before, result.tables);
    const updated = await prisma.source.update({ where: { id: sourceId }, data: { status: "ok", testedAt: new Date(), lastError: null } });
    await prisma.activity.create({ data: { projectId: source.projectId, env: source.env, kind: "connect", what: snap.reused ? `Synced ${source.env} schema - unchanged (${result.stats.tables} tables)` : `Synced ${source.env} schema - ${diff.summary}`, meta: JSON.stringify({ sourceId, snapshotId: snap.snapshotId, version: snap.version, previousSnapshotId: previous?.id ?? null, counts: diff.counts }) } });
    return { source: publicSource(updated, await latestSchemaSnapshot(source.projectId, sourceId)), snapshot: { ...snap, id: snap.snapshotId }, diff, reused: snap.reused, previousSnapshotId: previous?.id ?? null };
  } catch (e) {
    const msg = redact((e as Error).message, cfg.url);
    await prisma.source.update({ where: { id: sourceId }, data: { status: "error", testedAt: new Date(), lastError: `sync: ${msg}` } });
    throw new Error(msg);
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

/** Delete the source and its schema snapshots (nodes/edges cascade from Snapshot). */
export async function removeSource(sourceId: string): Promise<{ removedSnapshots: number }> {
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) return { removedSnapshots: 0 };
  const snaps = await prisma.snapshot.deleteMany({ where: { sourceId, kind: "schema" } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.activity.create({ data: { projectId: source.projectId, env: source.env, kind: "connect", what: `Removed ${source.env} database "${source.name}"`, meta: JSON.stringify({ sourceId, removedSnapshots: snaps.count }) } });
  return { removedSnapshots: snaps.count };
}

export async function patchSource(sourceId: string, patch: { name?: string; schemaOnly?: boolean }): Promise<PublicSource> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  const cfg = j<DbSourceConfig>(source.config, {});
  const data: { name?: string; config?: string } = {};
  if (typeof patch.name === "string" && patch.name.trim()) data.name = patch.name.trim().slice(0, 80);
  if (typeof patch.schemaOnly === "boolean") { cfg.schemaOnly = patch.schemaOnly; data.config = JSON.stringify(cfg); }
  const updated = Object.keys(data).length ? await prisma.source.update({ where: { id: sourceId }, data }) : source;
  return publicSource(updated, await latestSchemaSnapshot(source.projectId, sourceId));
}
