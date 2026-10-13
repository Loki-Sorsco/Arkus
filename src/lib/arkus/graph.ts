// Persist / load graphs and run impact analysis over them.
import { prisma, j } from "../db";
import type { GBinding, GEdge, GNode, Graph, NodeType } from "./types";

export async function persistGraph(snapshotId: string, graph: Graph) {
  const snap = await prisma.snapshot.findUniqueOrThrow({ where: { id: snapshotId } });
  await prisma.$transaction([
    prisma.node.deleteMany({ where: { snapshotId } }),
    prisma.edge.deleteMany({ where: { snapshotId } }),
    prisma.node.createMany({ data: graph.nodes.map((n) => ({ snapshotId, type: n.type, key: n.key, name: n.name, attrs: JSON.stringify(n.attrs || {}), file: n.file, lineStart: n.lineStart, lineEnd: n.lineEnd, confidence: n.confidence ?? 1, evidence: JSON.stringify(n.evidence || []) })) }),
    prisma.edge.createMany({ data: graph.edges.map((e) => ({ snapshotId, fromKey: e.from, toKey: e.to, type: e.type, confidence: e.confidence ?? 1, evidence: JSON.stringify(e.evidence || []) })) }),
  ]);
  if (snap.kind === "code" || snap.kind === "design") {
    await prisma.$transaction([
      prisma.binding.deleteMany({ where: { projectId: snap.projectId, source: { in: ["static", "designed"] } } }),
      prisma.binding.createMany({ data: graph.bindings.map((b) => ({ projectId: snap.projectId, ...b })) }),
    ]);
  }
}

export type LoadedGraph = Graph & { snapshotId: string | null; schemaSnapshotId: string | null; version: string | null; createdAt: string | null; stats: Record<string, unknown> };

/** Latest ready code snapshot merged with the latest schema snapshot (live DB wins for table columns). */
export async function loadGraph(projectId: string): Promise<LoadedGraph> {
  const [code, schema] = await Promise.all([
    prisma.snapshot.findFirst({ where: { projectId, kind: { in: ["code", "design"] }, status: "ready" }, orderBy: { createdAt: "desc" }, include: { nodes: true, edges: true } }),
    prisma.snapshot.findFirst({ where: { projectId, kind: "schema", status: "ready" }, orderBy: { createdAt: "desc" }, include: { nodes: true, edges: true } }),
  ]);
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const toNode = (n: { type: string; key: string; name: string; attrs: string; file: string | null; lineStart: number | null; lineEnd: number | null; confidence: number; evidence: string }): GNode => ({ type: n.type as NodeType, key: n.key, name: n.name, attrs: j(n.attrs, {}), file: n.file ?? undefined, lineStart: n.lineStart ?? undefined, lineEnd: n.lineEnd ?? undefined, confidence: n.confidence, evidence: j(n.evidence, []) });
  for (const s of [schema, code]) if (s) {
    for (const n of s.nodes) { const g = toNode(n); const ex = nodes.get(g.key); if (!ex) nodes.set(g.key, g); else nodes.set(g.key, { ...ex, ...g, attrs: { ...(g.attrs || {}), ...(ex.attrs || {}), ...(s === code && ex.attrs?.columns ? { columns: ex.attrs.columns, rowEstimate: ex.attrs.rowEstimate } : {}) } }); }
    for (const e of s.edges) if (!edges.some((x) => x.from === e.fromKey && x.to === e.toKey && x.type === e.type)) edges.push({ from: e.fromKey, to: e.toKey, type: e.type as GEdge["type"], confidence: e.confidence, evidence: j(e.evidence, []) });
  }
  const bindings = (await prisma.binding.findMany({ where: { projectId } })).map((b) => ({ pageKey: b.pageKey, fieldLabel: b.fieldLabel, uiType: b.uiType, apiKey: b.apiKey ?? undefined, keyName: b.keyName ?? undefined, keyType: b.keyType ?? undefined, tableName: b.tableName ?? undefined, columnName: b.columnName ?? undefined, colType: b.colType ?? undefined, kind: b.kind as GBinding["kind"], source: b.source as GBinding["source"], confidence: b.confidence }));
  const stats = j<Record<string, unknown>>(code?.stats, {});
  const unresolved = (stats.unresolvedList as Graph["unresolved"]) || [];
  return { nodes: [...nodes.values()], edges, bindings, unresolved, snapshotId: code?.id ?? null, schemaSnapshotId: schema?.id ?? null, version: code?.version ?? null, createdAt: code?.createdAt.toISOString() ?? null, stats };
}

/** Everything that depends on `key` (upstream: who uses this) and what it depends on (downstream). */
export function impactOf(graph: Graph, key: string) {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  const up = new Map<string, number>(); // nodes that use key (callers, readers, pages)
  const down = new Map<string, number>();
  const walk = (start: string, dir: "up" | "down", depth: number, acc: Map<string, number>) => {
    const next = dir === "up"
      ? graph.edges.filter((e) => e.to === start && e.type !== "contains").map((e) => e.from)
      : graph.edges.filter((e) => e.from === start && e.type !== "contains").map((e) => e.to);
    // column → its table counts as "used by" too
    if (dir === "up" && start.startsWith("column:")) next.push(...graph.edges.filter((e) => e.to === start && e.type === "contains").map((e) => e.from));
    for (const k of next) { if (k === key || acc.has(k)) continue; acc.set(k, depth); if (depth < 4) walk(k, dir, depth + 1, acc); }
  };
  walk(key, "up", 1, up); walk(key, "down", 1, down);
  const group = (m: Map<string, number>) => {
    const out: Record<string, { key: string; name: string; depth: number; file?: string }[]> = {};
    for (const [k, depth] of m) { const n = byKey.get(k); if (!n) continue; (out[n.type] ||= []).push({ key: k, name: n.name, depth, file: n.file }); }
    return out;
  };
  const usedBy = group(up), uses = group(down);
  const affected = (usedBy.endpoint?.length || 0) + (usedBy.screen?.length || 0) + (usedBy.apicall?.length || 0);
  const risk: "low" | "medium" | "high" = affected === 0 ? "low" : affected <= 3 ? "medium" : "high";
  return { usedBy, uses, risk, summary: summarize(usedBy) };
}

function summarize(usedBy: Record<string, { name: string }[]>): string {
  const parts: string[] = [];
  if (usedBy.endpoint?.length) parts.push(`${usedBy.endpoint.length} endpoint${usedBy.endpoint.length > 1 ? "s" : ""}`);
  if (usedBy.screen?.length) parts.push(`${usedBy.screen.length} page${usedBy.screen.length > 1 ? "s" : ""}`);
  if (usedBy.table?.length) parts.push(`${usedBy.table.length} table${usedBy.table.length > 1 ? "s" : ""}`);
  return parts.length ? `${parts.join(" and ")} will be affected` : "Nothing else depends on this";
}

/** ⌘K search over nodes, bindings and plans. */
export async function searchProject(projectId: string, q: string, limit = 20) {
  const g = await loadGraph(projectId);
  const needle = q.toLowerCase().trim();
  if (!needle) return [];
  const hits: { type: string; key: string; name: string; sub?: string; score: number }[] = [];
  for (const n of g.nodes) {
    if (n.type === "app") continue;
    const hay = `${n.name} ${n.key} ${n.file || ""}`.toLowerCase();
    const i = hay.indexOf(needle);
    if (i < 0) continue;
    hits.push({ type: n.type, key: n.key, name: n.name, sub: n.type === "column" ? String(n.attrs?.table) : n.file, score: (n.name.toLowerCase().startsWith(needle) ? 3 : n.name.toLowerCase().includes(needle) ? 2 : 1) + (n.type === "column" ? 0 : 0.5) });
  }
  const plans = await prisma.plan.findMany({ where: { projectId, title: { contains: q } }, take: 5 });
  for (const p of plans) hits.push({ type: "plan", key: `plan:${p.no}`, name: `#${p.no} ${p.title}`, sub: p.pipeline, score: 2 });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
