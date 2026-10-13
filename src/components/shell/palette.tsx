"use client";
// ⌘K: search the stack graph, or ask a question (first row hands the text to the Ask screen).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, cx } from "@/lib/ui";
import { Icon, Kbd } from "@/components/ui";
import { useWorkspace } from "./workspace";

type Hit = { type: string; key: string; name: string; sub?: string };
const ICON: Record<string, ReactNode> = { screen: Icon.pages({ size: 14 }), component: Icon.pages({ size: 14 }), endpoint: Icon.api({ size: 14 }), apicall: Icon.api({ size: 14 }), table: Icon.table({ size: 14 }), column: Icon.column({ size: 14 }), plan: Icon.spark({ size: 14 }), external: Icon.external({ size: 14 }) };
const looksLikeQuestion = (q: string) => /\?$|^(how|what|where|which|why|who|when|does|can|is|are|do)\b/i.test(q.trim());

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, project, openNode, openTab, openAsk } = useWorkspace();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [i, setI] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (paletteOpen) { setQ(""); setHits([]); setI(0); setTimeout(() => ref.current?.focus(), 10); } }, [paletteOpen]);
  useEffect(() => { if (!paletteOpen) return; const t = setTimeout(async () => { setHits(q.trim() ? await api<Hit[]>(`/api/projects/${project.slug}/search?q=${encodeURIComponent(q)}`) : []); setI(0); }, 120); return () => clearTimeout(t); }, [q, paletteOpen, project.slug]);
  if (!paletteOpen) return null;
  const askRow = q.trim().length > 2;
  const rows = askRow ? hits.length + 1 : hits.length; // row 0 = Ask when present
  const ask = () => { setPaletteOpen(false); openAsk(q.trim()); };
  const go = (h: Hit) => {
    setPaletteOpen(false);
    if (h.type === "plan") { openTab({ kind: "plans", label: "Plans", key: h.key.replace("plan:", "") }); return; }
    openNode(h.type === "column" ? `table:${h.sub}` : h.key);
  };
  const activate = (idx: number) => { if (askRow && idx === 0) ask(); else { const h = hits[askRow ? idx - 1 : idx]; if (h) go(h); } };
  return (
    <div className="fixed inset-0 z-[95] bg-black/60 flex items-start justify-center pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setPaletteOpen(false)}>
      <div className="card arise w-[640px] shadow-[0_24px_64px_rgba(0,0,0,.6)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
          <span className="text-dim">{Icon.search({ size: 15 })}</span>
          <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(x + 1, rows - 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); } if (e.key === "Enter") activate(i); if (e.key === "Escape") setPaletteOpen(false); }} placeholder="Search pages, APIs, tables… or ask a question" className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-dim" />
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[380px] overflow-auto py-1">
          {!q && <div className="px-4 py-6 text-center text-[12.5px] text-dim">Type to search the whole stack, or ask “how does login work?” · <Kbd>↑↓</Kbd> <Kbd>⏎</Kbd></div>}
          {askRow && (
            <div onMouseEnter={() => setI(0)} onClick={ask} className={cx("flex items-center gap-3 px-4 h-10 cursor-pointer text-[13.5px] border-b border-border/70", i === 0 ? "bg-surface-3" : "")}>
              <span className="w-5 text-center text-accent">{Icon.chat({ size: 15 })}</span>
              <span className="truncate"><span className="text-muted">Ask</span> “{q.trim()}”</span>
              <span className="ml-auto text-[11px] uppercase tracking-wide text-dim">{looksLikeQuestion(q) ? "question" : "ask"}</span>
            </div>
          )}
          {q && !hits.length && askRow && <div className="px-4 py-4 text-center text-[12.5px] text-dim">No exact matches — press Enter to ask instead.</div>}
          {hits.map((h, k) => { const idx = askRow ? k + 1 : k; return (
            <div key={h.key + k} onMouseEnter={() => setI(idx)} onClick={() => go(h)} className={cx("flex items-center gap-3 px-4 h-9 cursor-pointer text-[13.5px]", idx === i ? "bg-surface-3" : "")}>
              <span className="w-5 text-center text-dim flex items-center justify-center">{ICON[h.type] || "·"}</span>
              <span className="font-mono text-[13px] truncate">{h.name}</span>
              {h.sub && <span className="text-[12px] text-dim truncate">{h.sub}</span>}
              <span className="ml-auto text-[11px] uppercase tracking-wide text-dim">{h.type}</span>
            </div>
          ); })}
        </div>
      </div>
    </div>
  );
}
