"use client";
// Right column of the query console: Saved queries and History as collapsible sections (click to load,
// run, save / rename / unsave / delete). Resizable from its left edge; the console toggles it.
import { useState } from "react";
import { PanelSection } from "@/components/shell/side-panel";
import { ResizeHandle } from "@/components/shell/resize";
import { Chip, Icon, Spinner } from "@/components/ui";
import { cx, fmtNum, timeAgo } from "@/lib/ui";
import type { SavedQuery } from "./db-shared";

export type QueryAction = "save" | "unsave" | "rename" | "delete";
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export function QuerySide({ saved, history, loading, env, width, handle, onLoad, onRun, onAct, onName }: {
  saved: SavedQuery[]; history: SavedQuery[]; loading: boolean; env: string; width: number; handle: Record<string, unknown>;
  onLoad: (q: SavedQuery) => void; onRun: (q: SavedQuery) => void; onAct: (action: QueryAction, q: SavedQuery) => void; onName: (q: SavedQuery) => void;
}) {
  const [savedOpen, setSavedOpen] = useState(true);
  const [histOpen, setHistOpen] = useState(true);
  return (
    <div className="flex-none min-h-0 flex flex-col border-l border-border bg-surface relative" style={{ width }}>
      <ResizeHandle axis="x" className="left-0" {...handle} />
      <PanelSection title="Saved queries" count={saved.length} open={savedOpen} onToggle={() => setSavedOpen((o) => !o)} grow={savedOpen && !histOpen}>
        {saved.length ? saved.map((q) => (
          <div key={q.id} className="group tree-row h-auto min-h-[22px] py-1 pl-3 flex-col items-stretch gap-0" onClick={() => onLoad(q)} title={q.sql}>
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[12px] text-text truncate flex-1">{q.name || q.question || oneLine(q.sql, 40)}</span>
              <span className="flex-none flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button className="btn-icon btn-xs h-5 w-5" title="Run" aria-label="Run" onClick={(e) => { e.stopPropagation(); onRun(q); }}>{Icon.play({ size: 11 })}</button>
                <button className="btn-subtle btn-xs h-5 px-1" title="Rename" onClick={(e) => { e.stopPropagation(); onName(q); }}>Rename</button>
                <button className="btn-subtle btn-xs h-5 px-1" title="Unsave" onClick={(e) => { e.stopPropagation(); onAct("unsave", q); }}>Unsave</button>
                <button className="btn-icon btn-xs h-5 w-5 hover:text-red-soft" title="Delete" aria-label="Delete" onClick={(e) => { e.stopPropagation(); if (confirm("Delete this saved query?")) onAct("delete", q); }}>{Icon.trash({ size: 11 })}</button>
              </span>
            </div>
            <div className="text-[11px] text-dim font-mono truncate">{oneLine(q.sql, 80)}</div>
          </div>
        )) : <div className="px-3 py-2 text-[12px] text-dim">Nothing saved yet. Run a query, then save it from History.</div>}
      </PanelSection>
      <PanelSection title="History" open={histOpen} onToggle={() => setHistOpen((o) => !o)} grow right={loading ? <Spinner /> : <span className="text-[11px] text-dim">{env}</span>}>
        {history.length ? history.map((q) => (
          <div key={q.id} className="group tree-row h-auto min-h-[22px] py-1 pl-3 flex-col items-stretch gap-0" onClick={() => onLoad(q)} title={q.sql}>
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[12px] font-mono text-text-2 truncate flex-1">{oneLine(q.sql, 70)}</span>
              <button className={cx("btn-subtle btn-xs h-5 px-1 flex-none", q.saved ? "text-accent" : "opacity-0 group-hover:opacity-100")} title={q.saved ? "Saved" : "Save with a name"} onClick={(e) => { e.stopPropagation(); if (!q.saved) onName(q); }}>{q.saved ? "Saved" : "Save"}</button>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-dim"><Chip tone={q.status === "ok" ? "green" : q.status === "blocked" ? "amber" : "red"} className="h-[16px] px-1 text-[10.5px]">{q.status}</Chip><span>{fmtNum(q.rows)} rows · {q.ms} ms</span><span className="ml-auto">{timeAgo(q.createdAt)}</span></div>
          </div>
        )) : <div className="px-3 py-2 text-[12px] text-dim">No queries on {env} yet.</div>}
      </PanelSection>
    </div>
  );
}
