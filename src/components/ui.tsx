"use client";
// Shared primitives. Keep these small and boring: every screen is built out of them so the
// whole app reads as one surface. Colour rules: accent = primary action / active / link only.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { cx, methodColor } from "@/lib/ui";

// ---------- Toasts ----------
type Toast = { id: number; title: string; detail?: string; kind?: "info" | "ok" | "warn" | "error" };
const ToastCtx = createContext<{ toast: (t: Omit<Toast, "id">) => void }>({ toast: () => {} });
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { ...t, id }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[340px]">
        {list.map((t) => (
          <div key={t.id} className={cx("card arise p-3 shadow-[0_12px_32px_rgba(0,0,0,.45)] border-l-2", t.kind === "ok" ? "border-l-green" : t.kind === "warn" ? "border-l-amber" : t.kind === "error" ? "border-l-red" : "border-l-accent")}>
            <div className="text-[13px] font-semibold">{t.title}</div>
            {t.detail && <div className="text-[12.5px] text-muted mt-0.5 break-words">{t.detail}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Icons (16px, stroke) ----------
const I = ({ d, size = 16, className }: { d: string; size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden><path d={d} /></svg>
);
export const Icon = {
  map: (p?: { size?: number; className?: string }) => <I {...p} d="M9 20l-5.5-2.5V4L9 6.5m0 13.5l6-2.5M9 20V6.5m6 11l5.5 2.5V6.5L15 4m0 13.5V4M9 6.5l6-2.5" />,
  pages: (p?: { size?: number; className?: string }) => <I {...p} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm0 4h16M9 9v11" />,
  api: (p?: { size?: number; className?: string }) => <I {...p} d="M4 7h13l-3-3m6 13H7l3 3" />,
  db: (p?: { size?: number; className?: string }) => <I {...p} d="M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zm-8-3v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  plans: (p?: { size?: number; className?: string }) => <I {...p} d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM5 19l.7 1.8L7.5 21.5l-1.8.7L5 24M19 17l.5 1.3 1.3.5-1.3.5L19 20.6" />,
  activity: (p?: { size?: number; className?: string }) => <I {...p} d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  link: (p?: { size?: number; className?: string }) => <I {...p} d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" />,
  settings: (p?: { size?: number; className?: string }) => <I {...p} d="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.1l2-1.6-2-3.4-2.4.9a7.5 7.5 0 00-1.9-1.1L14.6 3H9.4L9 5.7a7.5 7.5 0 00-1.9 1.1l-2.4-.9-2 3.4 2 1.6a7.4 7.4 0 000 2.2l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 001.9 1.1l.4 2.7h5.2l.4-2.7a7.5 7.5 0 001.9-1.1l2.4.9 2-3.4-2-1.6c.1-.4.1-.7.1-1.1z" />,
  search: (p?: { size?: number; className?: string }) => <I {...p} d="M11 19a8 8 0 100-16 8 8 0 000 16zm10 2l-4.3-4.3" />,
  close: (p?: { size?: number; className?: string }) => <I {...p} d="M18 6L6 18M6 6l12 12" />,
  chevron: (p?: { size?: number; className?: string }) => <I {...p} d="M9 18l6-6-6-6" />,
  plus: (p?: { size?: number; className?: string }) => <I {...p} d="M12 5v14M5 12h14" />,
  refresh: (p?: { size?: number; className?: string }) => <I {...p} d="M21 12a9 9 0 11-2.6-6.4M21 3v6h-6" />,
  table: (p?: { size?: number; className?: string }) => <I {...p} d="M3 5h18v14H3zM3 10h18M3 15h18M9 5v14" />,
  check: (p?: { size?: number; className?: string }) => <I {...p} d="M20 6L9 17l-5-5" />,
  warn: (p?: { size?: number; className?: string }) => <I {...p} d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />,
  play: (p?: { size?: number; className?: string }) => <I {...p} d="M6 4l14 8-14 8V4z" />,
  back: (p?: { size?: number; className?: string }) => <I {...p} d="M19 12H5m7-7l-7 7 7 7" />,
  external: (p?: { size?: number; className?: string }) => <I {...p} d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6m4-3h6v6m-11 5L21 3" />,
  lock: (p?: { size?: number; className?: string }) => <I {...p} d="M5 11h14v10H5zM8 11V7a4 4 0 018 0v4" />,
  copy: (p?: { size?: number; className?: string }) => <I {...p} d="M9 9h10v12H9zM5 15V3h10" />,
  trash: (p?: { size?: number; className?: string }) => <I {...p} d="M3 6h18M8 6V4h8v2m-7 5v6m4-6v6M5 6l1 14h12l1-14" />,
  spark: (p?: { size?: number; className?: string }) => <I {...p} d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z" />,
  folder: (p?: { size?: number; className?: string }) => <I {...p} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />,
  git: (p?: { size?: number; className?: string }) => <I {...p} d="M6 3v12m0 0a3 3 0 100 6 3 3 0 000-6zm12-9a3 3 0 100-6 3 3 0 000 6zm0 0a6 6 0 01-6 6H9" />,
  layers: (p?: { size?: number; className?: string }) => <I {...p} d="M12 2l10 5-10 5L2 7l10-5zM2 12l10 5 10-5M2 17l10 5 10-5" />,
  column: (p?: { size?: number; className?: string }) => <I {...p} d="M4 4h16v16H4zM4 9h16M9 4v16" />,
  bolt: (p?: { size?: number; className?: string }) => <I {...p} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  chat: (p?: { size?: number; className?: string }) => <I {...p} d="M21 12a8 8 0 01-8 8H8l-5 3 1.5-4.5A8 8 0 1121 12z" />,
  flow: (p?: { size?: number; className?: string }) => <I {...p} d="M3 6h5v4H3zM16 14h5v4h-5zM8 8h4a2 2 0 012 2v4a2 2 0 002 2M3 16h5v4H3zM8 18h2" />,
};

// ---------- Small atoms ----------
export const Spinner = ({ className }: { className?: string }) => <span className={cx("spinner", className)} />;
export const Kbd = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;
export const Dot = ({ color = "green", pulse, className, title }: { color?: "green" | "amber" | "red" | "muted" | "accent" | "purple" | "teal" | "gold" | "blue"; pulse?: boolean; className?: string; title?: string }) => (
  <span title={title} className={cx("inline-block w-2 h-2 rounded-full flex-none", { green: "bg-green", amber: "bg-amber", red: "bg-red", muted: "bg-dim", accent: "bg-accent", purple: "bg-purple", teal: "bg-teal", gold: "bg-gold", blue: "bg-blue" }[color], pulse && "apulse", className)} />
);
export const MethodBadge = ({ method, className }: { method: string; className?: string }) => <span className={cx("chip font-mono font-semibold w-[58px] justify-center", methodColor(method), className)}>{method}</span>;
export type Tone = "muted" | "accent" | "green" | "amber" | "red" | "teal" | "purple" | "gold" | "blue";
export const TONE: Record<Tone, string> = { muted: "text-muted border-border bg-surface-2", accent: "text-accent border-accent/40 bg-accent/10", green: "text-green border-green/40 bg-green/10", amber: "text-amber border-amber/40 bg-amber/10", red: "text-red-soft border-red/40 bg-red/10", teal: "text-teal border-teal/40 bg-teal/10", purple: "text-purple border-purple/40 bg-purple/10", gold: "text-gold border-gold/40 bg-gold/10", blue: "text-blue border-blue/40 bg-blue/10" };
export const Chip = ({ children, tone = "muted", className, onClick, title }: { children: ReactNode; tone?: Tone; className?: string; onClick?: () => void; title?: string }) => (
  <span onClick={onClick} title={title} className={cx("chip", onClick && "cursor-pointer hover:brightness-110", TONE[tone], className)}>{children}</span>
);
export const Ref = ({ kind, children, onClick, className }: { kind: "table" | "column" | "function" | "endpoint" | "page" | "unresolved" | "external"; children: ReactNode; onClick?: () => void; className?: string }) => (
  <span onClick={onClick} className={cx("inline-flex items-center gap-1 font-mono text-[12px] px-1.5 h-[20px] rounded-[4px] border max-w-full", onClick && "cursor-pointer hover:brightness-125", { table: TONE.teal, column: TONE.teal, function: TONE.blue, endpoint: TONE.accent, page: TONE.gold, unresolved: TONE.amber, external: TONE.purple }[kind], className)}><span className="truncate">{children}</span></span>
);
export const Confidence = ({ value }: { value?: number }) => {
  const v = value ?? 1;
  if (v >= 0.9) return null;
  return <Chip tone={v >= 0.6 ? "amber" : "red"} title={`confidence ${Math.round(v * 100)}%`}>{v >= 0.6 ? "inferred" : "low confidence"}</Chip>;
};

export function EmptyState({ icon, title, hint, action, compact }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center gap-1.5 h-full", compact ? "p-6 min-h-[120px]" : "p-10 min-h-[240px]")}>
      {icon && <div className="w-10 h-10 rounded-full bg-surface-2 border border-border flex items-center justify-center text-muted mb-1">{icon}</div>}
      <div className="text-[14px] font-semibold text-text">{title}</div>
      {hint && <div className="text-[12.5px] text-muted max-w-[420px] leading-relaxed">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, width = 560, footer, subtitle }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card arise shadow-[0_24px_64px_rgba(0,0,0,.6)] flex flex-col max-h-full" style={{ width, maxWidth: "100%" }}>
        <div className="flex items-start justify-between px-5 py-3.5 border-b border-border"><div><div className="text-[14px] font-semibold">{title}</div>{subtitle && <div className="text-[12.5px] text-muted mt-0.5">{subtitle}</div>}</div><button onClick={onClose} className="btn-icon btn-sm -mr-2" aria-label="Close">{Icon.close()}</button></div>
        <div className="p-5 overflow-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">{footer}</div>}
      </div>
    </div>
  );
}

/** Segmented control. */
export function Tabs<T extends string>({ value, onChange, items, size = "md", className }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; count?: number; disabled?: boolean }[]; size?: "sm" | "md"; className?: string }) {
  return (
    <div className={cx("inline-flex gap-0.5 bg-bg-deep border border-border rounded-[6px] p-0.5", className)}>
      {items.map((it) => (
        <button key={it.id} disabled={it.disabled} onClick={() => onChange(it.id)} className={cx("px-2.5 rounded-[5px] font-medium transition cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed", size === "sm" ? "h-6 text-[12px]" : "h-7 text-[12.5px]", value === it.id ? "bg-surface-4 text-text shadow-[0_1px_0_rgba(0,0,0,.3)]" : "text-muted hover:text-text")}>{it.label}{it.count != null && <span className="ml-1.5 text-dim tabular-nums">{it.count}</span>}</button>
      ))}
    </div>
  );
}

/** Underlined tab strip (for screen-level sections). */
export function TabBar<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; count?: number; tone?: Tone }[] }) {
  return (
    <div className="flex items-end gap-1 h-full">
      {items.map((it) => (
        <button key={it.id} onClick={() => onChange(it.id)} className={cx("relative px-2.5 h-full text-[13px] font-medium transition cursor-pointer flex items-center gap-1.5", value === it.id ? "text-text" : "text-muted hover:text-text")}>
          {it.label}{it.count != null && <span className={cx("chip h-[18px] px-1.5 text-[11px]", it.tone ? TONE[it.tone] : "text-dim border-border bg-surface-2")}>{it.count}</span>}
          {value === it.id && <span className="absolute left-1 right-1 -bottom-px h-[2px] bg-accent rounded-full" />}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, right }: { label: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return <label className="block"><span className="flex items-center justify-between"><span className="label">{label}</span>{right}</span>{children}{hint && <span className="block text-[12px] text-dim mt-1">{hint}</span>}</label>;
}

export function Section({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("flex flex-col gap-2", className)}>
      {(title || right) && <div className="flex items-center justify-between h-5"><div className="eyebrow">{title}</div>{right}</div>}
      {children}
    </section>
  );
}

/** Standard screen header: 48px, title · meta · actions. */
export function PageHeader({ title, meta, children, right, className }: { title: ReactNode; meta?: ReactNode; children?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("h-12 flex-none flex items-center gap-3 px-4 border-b border-border bg-surface", className)}>
      <div className="flex items-center gap-2 min-w-0"><span className="text-[14px] font-semibold whitespace-nowrap">{title}</span>{meta && <span className="text-[12.5px] text-muted whitespace-nowrap truncate">{meta}</span>}</div>
      {children}
      <div className="flex-1" />
      {right && <div className="flex items-center gap-2 flex-none">{right}</div>}
    </div>
  );
}

/** Card with an optional header row. */
export function Panel({ title, right, children, className, pad = true, icon }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean; icon?: ReactNode }) {
  return (
    <div className={cx("panel", className)}>
      {(title || right) && <div className="panel-head">{icon && <span className="text-muted">{icon}</span>}<span>{title}</span><div className="flex-1" />{right}</div>}
      <div className={cx(pad && "p-4")}>{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-[88px]">
      <span className="text-[11px] uppercase tracking-[.06em] text-dim font-semibold">{label}</span>
      <span className={cx("text-[18px] font-semibold tabular-nums leading-tight", tone === "amber" ? "text-amber" : tone === "red" ? "text-red-soft" : tone === "green" ? "text-green" : "text-text")}>{value}</span>
      {sub && <span className="text-[11.5px] text-muted">{sub}</span>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (b: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer select-none">
      <span onClick={(e) => { e.preventDefault(); onChange(!checked); }} className={cx("mt-0.5 w-8 h-[18px] rounded-full border transition flex-none relative", checked ? "bg-accent border-accent" : "bg-surface-3 border-border-strong")}><span className={cx("absolute top-[2px] w-3 h-3 rounded-full bg-bg-deep transition", checked ? "left-[16px] bg-bg-deep" : "left-[2px] bg-muted")} /></span>
      <span className="text-[13px] text-text-2">{label}{hint && <span className="block text-[12px] text-dim">{hint}</span>}</span>
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder, className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cx("relative", className)}>
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none">{Icon.search({ size: 14 })}</span>
      <input autoFocus={autoFocus} className="input input-sm pl-8" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || "Filter"} />
      {value && <button onClick={() => onChange("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-dim hover:text-text cursor-pointer" aria-label="Clear">{Icon.close({ size: 13 })}</button>}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  return <button className={cx("btn-subtle btn-xs", className)} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { toast({ title: "Copy failed", kind: "error" }); } }}>{done ? Icon.check({ size: 13 }) : Icon.copy({ size: 13 })} {done ? "Copied" : label}</button>;
}

/** Minimal markdown → HTML (headings, code fences, lists, bold, inline code). Enough for guides. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0, list: "ol" | "ul" | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) { closeList(); const buf: string[] = []; i++; while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(l), ul = /^\s*[-*]\s+(.*)$/.exec(l);
    if (ol || ul) { const kind = ol ? "ol" : "ul"; if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline((ol || ul)![1])}</li>`); i++; continue; }
    if (/^\s{2,}\S/.test(l) && list) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, `<br/>${inline(l.trim())}</li>`); i++; continue; }
    closeList();
    if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  closeList();
  return <div className={cx("md", className)} dangerouslySetInnerHTML={{ __html: out.join("") }} />;
}
