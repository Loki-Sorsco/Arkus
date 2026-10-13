"use client";
// Architecture map: four lanes (Pages → APIs → Tables → Services). Pages and endpoints fold into route
// groups so a 50-endpoint app reads as ~8 cards; click a card to light up its full path (everything
// else fades), double-click to open it. Rich cards show type · name · two stats · file; compact mode
// shrinks them to one line. Blast radius mode paints everything that depends on the selected node red.
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState } from "react";
import type { LoadedGraph } from "@/lib/arkus/graph";
import type { GNode } from "@/lib/arkus/types";
import { cx, fmtNum, methodColor } from "@/lib/ui";

const LANES = ["screen", "endpoint", "table", "external"] as const;
type Lane = (typeof LANES)[number];
const LANE_LABEL: Record<Lane, string> = { screen: "Pages", endpoint: "APIs", table: "Tables", external: "Services" };
const TYPE_LABEL: Record<Lane, string> = { screen: "page", endpoint: "api", table: "table", external: "service" };
export const LANE_COLOR: Record<Lane, string> = { screen: "var(--gold)", endpoint: "var(--blue)", table: "var(--teal)", external: "var(--purple)" };
const PILL: Record<Lane, string> = { screen: "text-gold border-gold/40 bg-gold/10", endpoint: "text-blue border-blue/40 bg-blue/10", table: "text-teal border-teal/40 bg-teal/10", external: "text-purple border-purple/40 bg-purple/10" };
const W = 252, RICH_H = 118, SLIM_H = 44, GROUP_H = 32, LANE_H = 26, GAP = 8, LANE_GAP = 150, GROUP_GAP = 14;

type State = "normal" | "lit" | "dim" | "selected" | "blast" | "blast-root";
type Stat = { k: string; v: string };
type NodeData = { n: GNode; state: State; compact: boolean; stats: Stat[]; onSelect: (k: string) => void };
type GroupData = { label: string; lane: Lane; count: number; open: boolean; lit: number; dim: boolean; onToggle: () => void };
type LaneData = { label: string; lane: Lane; count: number };

const red = (s: State) => s === "blast" || s === "blast-root";
function MapNode({ data }: NodeProps<Node<NodeData>>) {
  const { n, state, compact, stats } = data;
  const lane = n.type as Lane;
  const method = n.type === "endpoint" ? String(n.attrs?.method || "") : "";
  const name = n.type === "endpoint" ? n.name.replace(/^[A-Z]+\s+/, "") : n.name;
  const on = state === "lit" || state === "selected" || red(state);
  const glowColor = red(state) ? "var(--red)" : LANE_COLOR[lane];
  const file = n.file ? n.file.split("/").slice(-2).join("/") : n.type === "external" ? String(n.attrs?.host || "") : "";
  return (
    <div onClick={(e) => { e.stopPropagation(); data.onSelect(n.key); }} style={{ width: W, height: compact ? SLIM_H : RICH_H, ["--glow" as string]: glowColor, borderColor: on ? glowColor : "var(--border)" }}
      className={cx("rounded-[7px] border bg-surface cursor-pointer transition-[opacity,border-color,box-shadow] hover:border-border-strong flex flex-col", compact ? "px-2.5 py-1.5 justify-center" : "px-3 py-2", state === "dim" && "opacity-[.18]", (state === "selected" || state === "blast-root") && "glow", (state === "lit" || state === "blast") && "glow-soft", red(state) && "bg-[#1a0e0e]")}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      {compact ? (
        <div className="flex items-center gap-1.5 min-w-0">
          {method ? <span className={cx("chip h-[16px] px-1 text-[10px] font-mono font-semibold", methodColor(method))}>{method}</span> : <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: LANE_COLOR[lane] }} />}
          <span className="font-mono text-[12.5px] truncate text-text font-medium">{name}</span>
          <span className="ml-auto text-[10.5px] text-dim truncate flex-none">{stats[0]?.v} {stats[0]?.k}</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cx("type-pill", red(state) ? "text-red-soft border-red/40 bg-red/10" : PILL[lane])}>{method || TYPE_LABEL[lane]}</span>
            {red(state) && <span className="type-pill text-red-soft border-red/50 bg-red/15">{state === "blast-root" ? "source" : "impacted"}</span>}
            <span className="ml-auto text-[9.5px] uppercase tracking-[.08em] text-dim truncate">{n.type === "endpoint" ? String(n.attrs?.framework || "") : n.type === "table" ? String(n.attrs?.source || "") : n.type === "screen" ? String(n.attrs?.kind || "page") : "external"}</span>
          </div>
          <div className="font-mono text-[13px] font-semibold text-text truncate mt-1" title={n.name}>{name}</div>
          <div className="grid grid-cols-2 gap-1.5 mt-1.5">
            {stats.slice(0, 2).map((s) => <div key={s.k} className="stat-box"><span className="k">{s.k}</span><span className="v">{s.v}</span></div>)}
          </div>
          <div className="text-[10px] text-dim truncate mt-1.5 font-mono" title={n.file || ""}>{file}</div>
        </>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div onClick={(e) => { e.stopPropagation(); data.onToggle(); }} className={cx("rounded-[6px] border bg-surface-2/80 px-2.5 flex items-center gap-2 cursor-pointer select-none transition-opacity hover:bg-surface-3", data.dim && "opacity-25")} style={{ width: W, height: GROUP_H, borderColor: data.lit ? LANE_COLOR[data.lane] : "var(--border-strong)" }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <span className="text-dim text-[10px] w-3">{data.open ? "▾" : "▸"}</span>
      <span className="font-mono text-[12px] text-text-2 truncate">{data.label}</span>
      <span className="ml-auto text-[11px] text-dim tabular-nums whitespace-nowrap">{data.lit ? `${data.lit} of ` : ""}{data.count}</span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
function LaneNode({ data }: NodeProps<Node<LaneData>>) {
  return (
    <div className="flex items-center gap-2 pointer-events-none" style={{ width: W, height: LANE_H }}>
      <span className="w-2 h-2 rounded-full" style={{ background: LANE_COLOR[data.lane] }} />
      <span className="text-[11px] font-semibold uppercase tracking-[.1em] text-muted">{data.label}</span>
      <span className="text-[11px] text-dim tabular-nums">{data.count}</span>
    </div>
  );
}
const nodeTypes = { item: MapNode, folder: GroupNode, lane: LaneNode };

const groupOf = (n: GNode): string | null => {
  if (n.type === "screen") { const seg = n.name.split("/").filter(Boolean)[0]; return seg && !seg.startsWith(":") ? "/" + seg : "/"; }
  if (n.type === "endpoint") { const path = n.name.replace(/^[A-Z]+\s+/, ""); const parts = path.split("/").filter(Boolean); const i = parts[0] === "api" ? 1 : 0; const seg = parts[i]; return seg && !seg.startsWith(":") ? "/" + parts.slice(0, i + 1).join("/") : "/" + parts.slice(0, i).join("/"); }
  return null;
};

/** Everything upstream of `key` (what would break if it changed), lane nodes only, through api calls. */
export function blastRadius(graph: LoadedGraph, key: string): Set<string> {
  const acc = new Set<string>();
  const walk = (k: string, depth: number) => {
    for (const e of graph.edges) {
      if (e.to !== k || e.type === "contains") continue;
      const from = e.from;
      if (acc.has(from) || from === key) continue;
      acc.add(from);
      if (depth < 6) walk(from, depth + 1);
    }
  };
  walk(key, 1);
  return acc;
}

export type Density = "auto" | "rich" | "compact";
export type MapProps = { graph: LoadedGraph; selection: string | null; onSelect: (k: string | null) => void; onOpen?: (k: string) => void; layer?: "all" | "pages" | "apis" | "db"; filter?: string; density?: Density; blast?: boolean };

export function ArchitectureMap({ graph, selection, onSelect, onOpen, layer = "all", filter = "", density = "auto", blast = false }: MapProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<string | null>(null);
  const toggle = useCallback((id: string) => setOpen((o) => ({ ...o, [id]: !o[id] })), []);

  const { nodes, edges } = useMemo(() => {
    const laneFilter = (t: string) => layer === "all" ? true : layer === "pages" ? t !== "external" : layer === "apis" ? t !== "screen" : t === "table" || t === "endpoint";
    const keep = graph.nodes.filter((n) => (LANES as readonly string[]).includes(n.type) && laneFilter(n.type));
    const keys = new Set(keep.map((n) => n.key));
    const byKey = new Map(keep.map((n) => [n.key, n]));
    const q = filter.trim().toLowerCase();
    const matches = (n: GNode) => !q || n.name.toLowerCase().includes(q);

    // stats per node (cheap counts over edges)
    const outBy = new Map<string, string[]>(), inBy = new Map<string, string[]>();
    for (const e of graph.edges) { if (e.type === "contains" || e.type === "renders" || e.type === "references") continue; (outBy.get(e.from) || outBy.set(e.from, []).get(e.from)!).push(e.to); (inBy.get(e.to) || inBy.set(e.to, []).get(e.to)!).push(e.from); }
    const statsOf = (n: GNode): Stat[] => {
      if (n.type === "screen") return [{ k: "fields", v: String(((n.attrs?.fields as unknown[]) || []).length) }, { k: "api calls", v: String((outBy.get(n.key) || []).filter((k) => k.startsWith("apicall:") || k.startsWith("endpoint:")).length) }];
      if (n.type === "endpoint") return [{ k: "tables", v: String(new Set((outBy.get(n.key) || []).filter((k) => k.startsWith("table:"))).size) }, { k: "callers", v: String(new Set((inBy.get(n.key) || []).map((k) => k.startsWith("apicall:") ? k.split("#")[0] : k)).size) }];
      if (n.type === "table") return [{ k: "columns", v: String(((n.attrs?.columns as unknown[]) || []).length) }, { k: "rows", v: n.attrs?.rowEstimate ? `~${fmtNum(Number(n.attrs.rowEstimate))}` : "–" }];
      return [{ k: "used by", v: String(new Set(inBy.get(n.key) || []).size) }, { k: "kind", v: String(n.attrs?.kind || "external") }];
    };

    // Path sets: `lit` (selection or hover) only affects styling; `litSel` (selection only) drives layout,
    // so hovering never moves cards around. Blast mode replaces the path with the upstream set.
    const pathOf = (start: string | null) => {
      const acc = new Set<string>();
      if (!start) return acc;
      acc.add(start);
      const walk = (k: string, dir: "up" | "down") => {
        for (const e of graph.edges) {
          if (e.type === "contains" || e.type === "renders" || e.type === "references") continue;
          const next = dir === "down" ? (e.from === k ? e.to : null) : (e.to === k ? e.from : null);
          if (!next || acc.has(next)) continue;
          if (next.startsWith("apicall:")) { acc.add(next); walk(next, dir); continue; }
          if (!keys.has(next)) continue;
          acc.add(next); walk(next, dir);
        }
      };
      walk(start, "down"); walk(start, "up");
      return acc;
    };
    const blastSet = blast && selection ? blastRadius(graph, selection) : null;
    const focus = blastSet ? selection : (selection || hover);
    const lit = blastSet ? new Set([selection!, ...blastSet]) : pathOf(focus);
    const litSel = blastSet ? lit : selection ? (focus === selection ? lit : pathOf(selection)) : new Set<string>();

    type Group = { id: string; label: string; lane: Lane; members: GNode[] };
    const lanes: Record<Lane, { singles: GNode[]; groups: Group[] }> = { screen: { singles: [], groups: [] }, endpoint: { singles: [], groups: [] }, table: { singles: [], groups: [] }, external: { singles: [], groups: [] } };
    const gmap = new Map<string, Group>();
    for (const n of keep) {
      const lane = n.type as Lane;
      const g = groupOf(n);
      if (g === null) { lanes[lane].singles.push(n); continue; }
      const id = `group:${lane}:${g}`;
      if (!gmap.has(id)) { const grp = { id, label: g, lane, members: [] }; gmap.set(id, grp); lanes[lane].groups.push(grp); }
      gmap.get(id)!.members.push(n);
    }
    const sortName = (a: GNode, b: GNode) => a.name.localeCompare(b.name);
    for (const lane of LANES) {
      const L = lanes[lane];
      const total = L.singles.length + L.groups.reduce((s, g) => s + g.members.length, 0);
      const keepGroups: Group[] = [];
      for (const g of L.groups) { if (g.members.length >= 2 && total > 8) keepGroups.push(g); else L.singles.push(...g.members); }
      L.groups = keepGroups.sort((a, b) => a.label.localeCompare(b.label));
      L.singles.sort(sortName);
      for (const g of L.groups) g.members.sort(sortName);
    }

    const rep = new Map<string, string>();
    const out: Node[] = [];
    const nodeState = (n: GNode): State => {
      if (blastSet) return n.key === selection ? "blast-root" : blastSet.has(n.key) ? "blast" : "dim";
      return n.key === selection ? "selected" : lit.has(n.key) ? "lit" : (focus || q) ? (q && matches(n) && !focus ? "normal" : "dim") : "normal";
    };
    LANES.forEach((lane, li) => {
      if (layer !== "all" && !laneFilter(lane)) return;
      const x = li * (W + LANE_GAP);
      let y = 0;
      const L = lanes[lane];
      const count = L.singles.length + L.groups.reduce((s, g) => s + g.members.length, 0);
      out.push({ id: `lane:${lane}`, type: "lane", position: { x, y }, data: { label: LANE_LABEL[lane], lane, count } as LaneData, selectable: false, draggable: false });
      y += LANE_H + 8;
      const push = (n: GNode) => {
        const rich = density === "rich" || (density === "auto" && (n.key === selection || litSel.has(n.key)));
        rep.set(n.key, n.key);
        out.push({ id: n.key, type: "item", position: { x, y }, data: { n, state: nodeState(n), compact: !rich, stats: statsOf(n), onSelect: (k: string) => onSelect(k) } as NodeData, draggable: false });
        y += (rich ? RICH_H : SLIM_H) + GAP;
      };
      for (const g of L.groups) {
        const litMembers = g.members.filter((m) => lit.has(m.key));
        const selMembers = g.members.filter((m) => litSel.has(m.key));
        const matched = q ? g.members.filter(matches) : [];
        const isOpen = !!open[g.id];
        const visible = (selection || blastSet) ? (isOpen ? g.members : selMembers) : q ? matched : isOpen ? g.members : [];
        const dim = (focus && !litMembers.length) || (!!q && !matched.length);
        out.push({ id: g.id, type: "folder", position: { x, y }, data: { label: g.label, lane, count: g.members.length, open: isOpen || visible.length > 0, lit: litMembers.length, dim, onToggle: () => toggle(g.id) } as GroupData, draggable: false });
        y += GROUP_H + GAP;
        for (const m of g.members) if (visible.includes(m)) push(m); else rep.set(m.key, g.id);
        y += GROUP_GAP - GAP;
      }
      for (const n of L.singles) push(n);
    });

    const agg = new Map<string, { source: string; target: string; count: number; lit: boolean; types: Set<string>; conf: number }>();
    for (const e of graph.edges) {
      if (e.type === "contains" || e.type === "renders" || e.type === "references") continue;
      if (e.from.startsWith("apicall:")) continue;
      const s = rep.get(e.from), t = rep.get(e.to);
      if (!s || !t || s === t) continue;
      const id = `${s}→${t}`;
      const on = lit.has(e.from) && lit.has(e.to);
      const cur = agg.get(id);
      if (cur) { cur.count++; cur.lit ||= on; cur.types.add(e.type); cur.conf = Math.min(cur.conf, e.confidence ?? 1); }
      else agg.set(id, { source: s, target: t, count: 1, lit: on, types: new Set([e.type]), conf: e.confidence ?? 1 });
    }
    const edges: Edge[] = [...agg.entries()].map(([id, a]) => {
      const srcType = (byKey.get(a.source)?.type || a.source.split(":")[1] || "endpoint") as Lane;
      const label = a.types.has("writes") ? "writes" : a.types.has("reads") ? "reads" : undefined;
      const color = blastSet ? "var(--red)" : LANE_COLOR[srcType];
      return { id, source: a.source, target: a.target, type: "smoothstep", animated: a.lit, className: a.lit ? "lit" : undefined, style: { stroke: a.lit ? color : "var(--border-strong)", strokeWidth: a.lit ? 1.6 : 1, opacity: focus ? (a.lit ? 1 : 0.05) : q ? 0.12 : 0.4, strokeDasharray: a.lit ? "5 4" : a.conf < 0.9 ? "4 3" : undefined }, label: a.lit && label ? (a.count > 1 ? `${label} ·${a.count}` : label) : undefined, labelStyle: { fill: a.lit ? "var(--text-2)" : "var(--dim)", fontSize: 10, fontFamily: "var(--font-mono)" }, labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.9 }, labelBgPadding: [3, 2] as [number, number] };
    });
    return { nodes: out, edges };
  }, [graph, selection, hover, onSelect, layer, filter, open, toggle, density, blast]);

  return (
    <div className="h-full w-full arkus-map">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }} minZoom={0.12} maxZoom={1.6} onPaneClick={() => onSelect(null)} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} colorMode="dark" style={{ background: "var(--bg)" }} onNodeMouseEnter={(_, n) => { if (n.type === "item" && !blast) setHover(n.id); }} onNodeMouseLeave={() => setHover(null)} onNodeDoubleClick={(_, n) => { if (n.type === "item") onOpen?.(n.id); }}>
        <Background variant={BackgroundVariant.Dots} color="#2A2D33" gap={22} size={1.2} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
