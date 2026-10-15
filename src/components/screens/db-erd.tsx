"use client";
// Schema tab: entity-relationship diagram. One node per table (columns with ● PK / ◆ FK / ▤ index
// markers), teal smoothstep edges for foreign keys, column-level source handles so an edge leaves
// from the FK row. Click selects the table (→ Inspector); pan/zoom via React Flow.
import { useLook } from "@/lib/theme";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { Icon } from "@/components/ui";
import { cx } from "@/lib/ui";
import type { DbColumn, DbTable } from "./db-shared";

const MAX_COLS = 16;
const ROW_H = 20, HEAD_H = 36, PAD = 10, NODE_W = 230, GAP_X = 90, GAP_Y = 36;

type Data = { t: DbTable; lit: boolean; dim: boolean; related: Set<string>; onSelect: (name: string) => void };

function marker(c: DbColumn, t: DbTable) {
  if (c.pk) return { m: "●", tone: "text-gold", title: "primary key" };
  if (c.references) return { m: "◆", tone: "text-teal", title: `foreign key → ${c.references.table}.${c.references.column}` };
  if (c.index || c.unique || t.indexes.some((i) => i.columns.includes(c.name))) return { m: "▤", tone: "text-dim", title: c.unique ? "unique index" : "indexed" };
  return { m: "", tone: "", title: "" };
}

function TableNode({ data }: NodeProps<Node<Data>>) {
  const { t, lit, dim } = data;
  const cols = t.columns.slice(0, MAX_COLS);
  return (
    <div onClick={() => data.onSelect(t.name)} className={cx("rounded-[6px] border bg-surface text-[12px] cursor-pointer transition overflow-hidden", dim && "opacity-30", lit && "shadow-[0_0_0_2px_var(--teal)]")} style={{ width: NODE_W, borderColor: lit ? "var(--teal)" : "var(--border)" }}>
      <Handle type="target" id="t" position={Position.Left} style={{ opacity: 0, top: HEAD_H / 2 }} />
      <div className="flex items-center gap-1.5 px-2.5 border-b border-border bg-surface-2" style={{ height: HEAD_H }}>
        <span className="font-mono font-semibold truncate">{t.name}</span>
        <span className="ml-auto text-[10.5px] text-dim whitespace-nowrap">{t.rowEstimate != null ? `~${Number(t.rowEstimate).toLocaleString()}` : `${t.columns.length} col`}</span>
      </div>
      <div style={{ padding: `${PAD / 2}px 0` }}>
        {cols.map((c) => {
          const mk = marker(c, t);
          return (
            <div key={c.name} className="relative flex items-center gap-1.5 px-2.5" style={{ height: ROW_H }} title={`${c.name} ${c.type}${c.nullable ? " null" : ""}${mk.title ? " · " + mk.title : ""}`}>
              <span className={cx("w-3 text-center text-[9px]", mk.tone)}>{mk.m}</span>
              <span className={cx("font-mono truncate", c.pk ? "text-text" : "text-text-2")}>{c.name}</span>
              <span className="ml-auto text-[10px] text-dim font-mono truncate max-w-[80px]">{c.type}{c.nullable ? "?" : ""}</span>
              {(c.secret || c.pii) && <span className={c.secret ? "text-red-soft" : "text-amber"} title={c.secret ? "never returned" : "masked personal data"}>{Icon.lock({ size: 10 })}</span>}
              {c.references && <Handle type="source" id={`c:${c.name}`} position={Position.Right} style={{ opacity: 0, top: "50%", right: 0 }} />}
            </div>
          );
        })}
        {t.columns.length > MAX_COLS && <div className="px-2.5 text-[10.5px] text-dim" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>+{t.columns.length - MAX_COLS} more columns</div>}
        {!t.columns.length && <div className="px-2.5 text-[10.5px] text-dim" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>columns unknown</div>}
      </div>
    </div>
  );
}
const nodeTypes = { table: TableNode };
const nodeHeight = (t: DbTable) => HEAD_H + PAD + ROW_H * Math.max(1, Math.min(t.columns.length, MAX_COLS) + (t.columns.length > MAX_COLS ? 1 : 0));

export function SchemaErd({ tables, selection, onSelect }: { tables: DbTable[]; selection: string | null; onSelect: (name: string | null) => void }) {
  const look = useLook();
  const { nodes, edges } = useMemo(() => {
    const names = new Set(tables.map((t) => t.name));
    // FK links (only those whose target table is known)
    const links: { from: string; col: string; to: string; toCol: string }[] = [];
    for (const t of tables) for (const c of t.columns) if (c.references && names.has(c.references.table) && c.references.table !== t.name) links.push({ from: t.name, col: c.name, to: c.references.table, toCol: c.references.column });
    const degree = new Map<string, number>();
    for (const l of links) { degree.set(l.from, (degree.get(l.from) || 0) + 1); degree.set(l.to, (degree.get(l.to) || 0) + 1); }
    // layout: hubs first, column-major packing with cumulative heights
    const order = [...tables].sort((a, b) => (degree.get(b.name) || 0) - (degree.get(a.name) || 0) || a.name.localeCompare(b.name));
    const perCol = Math.max(2, Math.ceil(Math.sqrt(order.length * 0.7)));
    const related = new Set<string>();
    const sel = selection?.startsWith("table:") ? selection.slice(6) : null;
    if (sel) { related.add(sel); for (const l of links) { if (l.from === sel) related.add(l.to); if (l.to === sel) related.add(l.from); } }
    const nodes: Node<Data>[] = [];
    const ys: number[] = [];
    order.forEach((t, i) => {
      const ci = Math.floor(i / perCol);
      const y = ys[ci] || 0;
      nodes.push({ id: t.name, type: "table", position: { x: ci * (NODE_W + GAP_X), y }, data: { t, lit: sel === t.name, dim: !!sel && !related.has(t.name), related, onSelect: (n) => onSelect(n) } });
      ys[ci] = y + nodeHeight(t) + GAP_Y;
    });
    const edges: Edge[] = links.map((l) => {
      const on = sel ? l.from === sel || l.to === sel : false;
      return { id: `${l.from}.${l.col}→${l.to}`, source: l.from, sourceHandle: `c:${l.col}`, target: l.to, targetHandle: "t", type: "smoothstep", animated: on, style: { stroke: "var(--teal)", strokeWidth: on ? 2 : 1.2, opacity: sel && !on ? 0.12 : 0.75 }, label: on ? `${l.col} → ${l.toCol}` : undefined, labelStyle: { fill: "var(--teal)", fontSize: 10, fontFamily: "var(--font-mono)" }, labelBgStyle: { fill: "var(--bg)" } };
    });
    return { nodes, edges };
  }, [tables, selection, onSelect]);

  return (
    <div className="h-full w-full relative">
      <ReactFlow key={tables.length} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.15} maxZoom={1.8} proOptions={{ hideAttribution: true }} onPaneClick={() => onSelect(null)} nodesDraggable nodesConnectable={false} colorMode={look.theme} style={{ background: "var(--bg)" }}>
        <Background color="#2C221B" gap={24} />
        <Controls showInteractive={false} style={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
      </ReactFlow>
      <div className="absolute left-3 bottom-3 flex gap-3 text-[11.5px] text-dim bg-surface/80 border border-border rounded-[6px] px-2.5 py-1.5 backdrop-blur">
        <span><span className="text-gold">●</span> primary key</span><span><span className="text-teal">◆</span> foreign key</span><span><span className="text-dim">▤</span> index</span><span className="inline-flex items-center gap-1">{Icon.lock({ size: 11 })} masked / hidden</span>
      </div>
    </div>
  );
}
