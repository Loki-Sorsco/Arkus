"use client";
// Wireframe of a page, drawn from its sketch: a browser window on a grey canvas with labelled input
// boxes, a submit button, table skeletons and grey text lines. Static boxes only, so it reads as a
// sketch rather than a design. A rail on the right lists the APIs it calls and the tables behind them.
import { useState } from "react";
import { PanelSection } from "@/components/shell/side-panel";
import { useWorkspace } from "@/components/shell/workspace";
import { MethodBadge, Ref } from "@/components/ui";
import type { PageSketch, SketchField, SketchSection } from "@/lib/arkus/sketch";
import { cx } from "@/lib/ui";

const HINT: Record<string, string> = { text: "text", email: "email", password: "password", number: "number", date: "date", select: "choose one", checkbox: "yes/no", textarea: "longer text", hidden: "hidden", tel: "phone", url: "link", file: "file", search: "search", radio: "pick one" };
const hintOf = (t: string) => HINT[t.toLowerCase()] || t.toLowerCase();

export function PageSketchView({ sketch }: { sketch: PageSketch }) {
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 overflow-auto bg-surface-2 p-6">
        <div className="max-w-[720px] mx-auto rounded-[9px] border border-border bg-bg-deep shadow-[0_8px_24px_rgba(0,0,0,.08)] overflow-hidden">
          <div className="h-9 flex items-center gap-2 px-3 border-b border-border bg-surface">
            <span className="flex gap-1"><i className="w-2.5 h-2.5 rounded-full bg-surface-4" /><i className="w-2.5 h-2.5 rounded-full bg-surface-4" /><i className="w-2.5 h-2.5 rounded-full bg-surface-4" /></span>
            <span className="flex-1 h-6 rounded-[5px] border border-border bg-bg-deep flex items-center px-2 font-mono text-[11.5px] text-muted truncate">{sketch.path}</span>
          </div>
          <div className="px-6 py-4 border-b border-border flex items-center gap-3">
            <span className="text-[15px] font-semibold text-text truncate prose">{sketch.header.title}</span>
            <span className="flex-1" />
            <i className="w-14 h-2 rounded bg-surface-3" /><i className="w-10 h-2 rounded bg-surface-3" />
          </div>
          <div className="px-6 py-5 flex flex-col gap-5">{sketch.sections.map((s, i) => <SectionView key={i} s={s} />)}</div>
        </div>
      </div>
      <Rail sketch={sketch} />
    </div>
  );
}

function SectionView({ s }: { s: SketchSection }) {
  if (s.kind === "form") return (
    <div className="rounded-[7px] border border-border bg-surface p-4 flex flex-col gap-3">
      {s.fields.map((f, i) => <FieldBox key={i} f={f} />)}
      {s.submit && (
        <div className="pt-1 flex items-center gap-3">
          <span className="inline-flex items-center h-8 px-4 rounded-[6px] bg-accent text-bg-deep text-[12.5px] font-medium select-none prose">{s.submit.label}</span>
          <span className="text-[11px] text-dim prose">{s.submit.api ? <>sends <span className="font-mono">{s.submit.api}</span></> : "no API call found"}</span>
        </div>
      )}
    </div>
  );
  if (s.kind === "list") return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[13px] font-medium text-text prose">{s.title}</span>
        <span className="text-[11px] text-dim prose">reads <span className="font-mono">{s.source}</span></span>
        <span className="flex-1" />
        {s.table && <span className="text-[11px] text-dim prose">from table <span className="font-mono">{s.table}</span></span>}
      </div>
      <div className="rounded-[7px] border border-border bg-surface overflow-hidden">
        <div className="h-7 flex items-center gap-4 px-3 bg-surface-2 border-b border-border"><i className="w-24 h-2 rounded bg-surface-4" /><i className="w-16 h-2 rounded bg-surface-4" /><i className="w-20 h-2 rounded bg-surface-4" /></div>
        {[0.7, 0.5, 0.6].map((w, i) => <div key={i} className="h-8 flex items-center gap-4 px-3 border-b border-border/60 last:border-b-0"><i className="h-2 rounded bg-surface-3" style={{ width: `${w * 160}px` }} /><i className="h-2 rounded bg-surface-3" style={{ width: `${(1 - w) * 160}px` }} /><i className="w-12 h-2 rounded bg-surface-3" /></div>)}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium text-text prose">{s.title}</span>
      <div className="flex flex-col gap-2 pt-1">{[0.95, 0.8, 0.9, 0.55].map((w, i) => <i key={i} className="h-2 rounded bg-surface-3" style={{ width: `${w * 100}%` }} />)}</div>
    </div>
  );
}

function FieldBox({ f }: { f: SketchField }) {
  const t = f.uiType.toLowerCase();
  const check = t === "checkbox" || t === "radio";
  return (
    <div className="flex flex-col gap-1 min-w-0">
      {check ? (
        <div className="flex items-center gap-2"><i className={cx("w-3.5 h-3.5 border border-border-strong bg-bg-deep flex-none", t === "radio" ? "rounded-full" : "rounded-[3px]")} /><span className="text-[12.5px] text-text-2 prose truncate">{f.label}{f.required && <span className="text-dim"> *</span>}</span><span className="text-[11px] text-dim prose">{hintOf(t)}</span></div>
      ) : (
        <>
          <span className="text-[12px] text-text-2 prose truncate">{f.label}{f.required && <span className="text-dim" title="required"> *</span>}</span>
          <div className={cx("rounded-[5px] border border-border-strong bg-bg-deep px-2.5 flex text-[11.5px] text-dim prose", t === "textarea" ? "h-14 items-start pt-1.5" : "h-8 items-center")}>{hintOf(t)}{t === "select" && <span className="ml-auto">▾</span>}</div>
        </>
      )}
      <span className="text-[10.5px] text-dim prose truncate" title={f.savedTo ? `${f.savedTo}${f.via ? ` via ${f.via}` : ""}` : undefined}>
        {f.savedTo ? <>→ <span className="font-mono">{f.savedTo}</span>{f.via && <> via <span className="font-mono">{f.via}</span></>}</> : f.via ? <>→ sent with <span className="font-mono">{f.via}</span>, not saved to a table</> : "not saved"}
      </span>
    </div>
  );
}

function Rail({ sketch }: { sketch: PageSketch }) {
  const { openNode } = useWorkspace();
  const [calls, setCalls] = useState(true);
  const [data, setData] = useState(true);
  const [links, setLinks] = useState(true);
  const tables = [...new Set(sketch.calls.flatMap((c) => c.tables))].sort();
  return (
    <div className="hidden min-[1200px]:flex w-[240px] flex-none border-l border-border bg-surface flex-col min-h-0 overflow-auto">
      <PanelSection title="Calls" count={sketch.calls.length} open={calls} onToggle={() => setCalls((o) => !o)}>
        {sketch.calls.length ? sketch.calls.map((c) => (
          <div key={c.key} className="tree-row pl-2" onClick={() => openNode(c.key)} title={`${c.method} ${c.path}`}><MethodBadge method={c.method} className="w-[44px] h-[15px] text-[9.5px] px-0" /><span className="truncate font-mono text-[12px]">{c.path}</span></div>
        )) : <div className="px-3 py-1.5 text-[11.5px] text-dim prose">This page calls no API.</div>}
      </PanelSection>
      <PanelSection title="Data it touches" count={tables.length} open={data} onToggle={() => setData((o) => !o)}>
        {tables.length ? <div className="px-2 py-1 flex flex-wrap gap-1">{tables.map((t) => <Ref key={t} kind="table" onClick={() => openNode(`table:${t}`)}>{t}</Ref>)}</div> : <div className="px-3 py-1.5 text-[11.5px] text-dim prose">No table behind this page.</div>}
      </PanelSection>
      {sketch.links.length > 0 && (
        <PanelSection title="Links to" count={sketch.links.length} open={links} onToggle={() => setLinks((o) => !o)}>
          <div className="px-2 py-1 flex flex-wrap gap-1">{sketch.links.map((k) => <Ref key={k} kind="page" onClick={() => openNode(k)}>{k.replace(/^screen:/, "")}</Ref>)}</div>
        </PanelSection>
      )}
    </div>
  );
}
