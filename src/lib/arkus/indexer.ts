// Index pipeline: walk → scrub → detect → extract → resolve → persist snapshot. Streams progress
// through `onLog` so the Import screen can show the analysis as it happens.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../db";
import { detectStack } from "./detect";
import { extractors } from "./extractors";
import { makeReader, walkRepo } from "./fs";
import { resolveGraph } from "./resolve";
import { emptyFacts, type Detected, type ExtractContext, type Facts, type Graph } from "./types";
import { persistGraph } from "./graph";

const exec = promisify(execFile);
export type LogLine = { t: number; stage: string; msg: string; level: "info" | "warn" | "error" | "done" };
export type IndexResult = { snapshotId: string; graph: Graph; det: Detected; stats: Record<string, number> };

async function gitSha(root: string): Promise<string | null> {
  try { const { stdout } = await exec("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5000 }); return stdout.trim() || null; } catch { return null; }
}

export async function indexProject(projectId: string, onLog?: (l: LogLine) => void): Promise<IndexResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.rootPath) throw new Error("Project has no local folder");
  const root = project.rootPath;
  const log: LogLine[] = [];
  const say = (stage: string, msg: string, level: LogLine["level"] = "info") => { const l = { t: Date.now(), stage, msg, level }; log.push(l); onLog?.(l); };

  const snapshot = await prisma.snapshot.create({ data: { projectId, kind: "code", version: "pending", status: "building" } });
  await prisma.project.update({ where: { id: projectId }, data: { status: "indexing" } });
  try {
    say("clone", `Reading ${root}`);
    const sha = await gitSha(root);
    const { files, skipped, secretFiles } = await walkRepo(root);
    say("clone", `${files.length} files to analyse (${skipped} skipped)${sha ? ` · commit ${sha.slice(0, 7)}` : " · not a git repo"}`);
    if (secretFiles.length) say("scrub", `${secretFiles.length} secret file${secretFiles.length > 1 ? "s" : ""} left unread (${secretFiles.slice(0, 3).join(", ")}${secretFiles.length > 3 ? "…" : ""})`, "warn");

    const reader = makeReader(root);
    const det = await detectStack(files, reader.read);
    say("detect", `Stack: ${det.summary}${det.monorepo ? ` · monorepo (${det.monorepo.tool})` : ""}`);
    if (!det.frameworks.length) say("detect", "No known framework detected — routes will be inferred with low confidence", "warn");

    const facts: Facts = emptyFacts();
    const ctx: ExtractContext = { root, files, det, read: reader.read, log: (m, level = "info") => say("extract", m, level) };
    for (const ex of extractors) {
      if (!ex.applies(det, files)) continue;
      const t0 = Date.now();
      try {
        const part = await ex.run(ctx);
        for (const k of Object.keys(part) as (keyof Facts)[]) (facts[k] as unknown[]).push(...((part[k] as unknown[]) || []));
        const n = Object.values(part).reduce((a, v) => a + ((v as unknown[])?.length || 0), 0);
        if (n) say("extract", `${ex.name}: ${n} facts (${Date.now() - t0} ms)`);
      } catch (e) { say("extract", `${ex.name} failed: ${(e as Error).message}`, "error"); }
    }
    say("extract", `${facts.routes.length} routes · ${facts.screens.length} screens/components · ${facts.apicalls.length} API calls · ${facts.tables.length} tables`);
    if (reader.secretsFound()) say("scrub", `${reader.secretsFound()} secret-looking value${reader.secretsFound() > 1 ? "s" : ""} redacted inside source files`, "warn");

    // merge schema from a connected database snapshot if present (introspection wins for columns)
    const schemaSnap = await prisma.snapshot.findFirst({ where: { projectId, kind: "schema", status: "ready" }, orderBy: { createdAt: "desc" }, include: { nodes: { where: { type: "table" } } } });
    if (schemaSnap) {
      for (const n of schemaSnap.nodes) {
        const attrs = JSON.parse(n.attrs) as { columns?: Facts["tables"][number]["columns"]; rowEstimate?: number; indexes?: Facts["tables"][number]["indexes"] };
        facts.tables.push({ name: n.name, columns: attrs.columns || [], source: "introspection", rowEstimate: attrs.rowEstimate, indexes: attrs.indexes });
      }
      say("resolve", `Merged live schema (${schemaSnap.nodes.length} tables) from the connected database`);
    }

    say("resolve", "Linking screens → API calls → endpoints → tables");
    const graph = resolveGraph(facts, { appName: project.name });
    const stats = {
      files: files.length, screens: graph.nodes.filter((n) => n.type === "screen").length, endpoints: graph.nodes.filter((n) => n.type === "endpoint").length,
      tables: graph.nodes.filter((n) => n.type === "table").length, apicalls: graph.nodes.filter((n) => n.type === "apicall").length,
      bindings: graph.bindings.length, unresolved: graph.unresolved.length, externals: graph.nodes.filter((n) => n.type === "external").length,
    };
    say("resolve", `${stats.bindings} bindings recorded in the stack graph · ${stats.unresolved} unresolved`);
    for (const u of graph.unresolved.slice(0, 8)) say("resolve", u.message, "warn");

    say("persist", "Saving snapshot");
    const version = sha || crypto.createHash("sha1").update(JSON.stringify(graph.nodes.map((n) => n.key))).digest("hex");
    await persistGraph(snapshot.id, graph);
    await prisma.snapshot.update({ where: { id: snapshot.id }, data: { version, status: "ready", stats: JSON.stringify({ ...stats, det, unresolvedList: graph.unresolved }), log: JSON.stringify(log) } });
    await prisma.project.update({ where: { id: projectId }, data: { status: "ready", stack: JSON.stringify(det) } });
    await prisma.activity.create({ data: { projectId, kind: "index", what: `Indexed ${stats.endpoints} endpoints, ${stats.screens} pages, ${stats.tables} tables`, meta: JSON.stringify({ snapshotId: snapshot.id, version, stats }) } });
    say("done", `Map ready: ${stats.screens} pages · ${stats.endpoints} APIs · ${stats.tables} tables`, "done");
    return { snapshotId: snapshot.id, graph, det, stats };
  } catch (e) {
    say("error", (e as Error).message, "error");
    await prisma.snapshot.update({ where: { id: snapshot.id }, data: { status: "failed", log: JSON.stringify(log) } });
    await prisma.project.update({ where: { id: projectId }, data: { status: "error" } });
    throw e;
  }
}
