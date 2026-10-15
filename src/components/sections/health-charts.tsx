"use client";
// Plain-SVG charts for the Health screen. One series = one hue (accent); status colours (green / amber /
// red) always come with a text label; grid and axes are recessive; colours are CSS variables so both
// themes work. No chart library.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "@/lib/ui";

export type Tone = "ok" | "warn" | "bad" | "neutral";
const TONE_VAR: Record<Tone, string> = { ok: "var(--green)", warn: "var(--amber)", bad: "var(--red)", neutral: "var(--muted)" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-green", warn: "text-amber", bad: "text-red-soft", neutral: "text-muted" };

/** 42 ms · 1.8 s · — */
export const fmtMs = (ms: number | null | undefined) => ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
export const fmtPct = (p: number | null | undefined) => (p == null ? "—" : `${Math.round(p)}%`);
const fmtTime = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`; };
const fmtClock = (ms: number, span: number) => { const d = new Date(ms); return span > 36 * 3600e3 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };

/** Thin trend line; `zeroAsGap` leaves holes where the value is 0 (a failed probe has no latency). */
export function Sparkline({ values, width = 96, height = 24, zeroAsGap, color = "var(--accent)", className }: { values: number[]; width?: number; height?: number; zeroAsGap?: boolean; color?: string; className?: string }) {
  const d = useMemo(() => {
    const vs = values.filter((v) => !(zeroAsGap && v === 0));
    if (values.length < 2 || !vs.length) return "";
    const max = Math.max(...vs, 1), min = Math.min(...vs);
    const span = max - min || 1;
    const step = (width - 2) / Math.max(1, values.length - 1);
    let out = "", pen = false;
    values.forEach((v, i) => {
      if (zeroAsGap && v === 0) { pen = false; return; }
      const x = 1 + i * step, y = height - 2 - ((v - min) / span) * (height - 4);
      out += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; pen = true;
    });
    return out;
  }, [values, width, height, zeroAsGap]);
  if (!d) return <svg width={width} height={height} className={className} aria-hidden><line x1={1} y1={height / 2} x2={width - 1} y2={height / 2} style={{ stroke: "var(--border-strong)" }} strokeWidth={1} strokeDasharray="2 3" /></svg>;
  return <svg width={width} height={height} className={cx("flex-none", className)} aria-hidden><path d={d} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/** Stat tile: label · value · one-line delta/sub · optional sparkline. Status tone always ships with the text in `sub`. */
export function StatTile({ label, value, sub, tone = "neutral", spark, sparkGap, onClick, active, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; spark?: number[]; sparkGap?: boolean; onClick?: () => void; active?: boolean; children?: ReactNode }) {
  return (
    <div onClick={onClick} className={cx("card px-3.5 py-3 flex flex-col gap-1.5 min-w-0", onClick && "cursor-pointer hover:border-border-strong transition", active && "border-border-strong bg-surface-2")}>
      <div className="eyebrow truncate">{label}</div>
      <div className="flex items-end justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-[20px] font-semibold tabular-nums leading-none text-text">{value}</div>
          {sub && (tone === "neutral" ? <div className="text-[11.5px] leading-snug mt-1.5 truncate text-muted">{sub}</div> : <StateLabel tone={tone} className="text-[11.5px] leading-snug mt-1.5 max-w-full"><span className="truncate">{sub}</span></StateLabel>)}
        </div>
        {spark && spark.length > 1 && <Sparkline values={spark} width={72} height={26} zeroAsGap={sparkGap} />}
        {children}
      </div>
    </div>
  );
}

/** Dot + label. Never colour alone. */
export function StateLabel({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap", TONE_TEXT[tone], className)}><span className="inline-block w-2 h-2 rounded-full flex-none" style={{ background: TONE_VAR[tone] }} aria-hidden />{children}</span>;
}

export type LinePoint = { at: string; ms: number; status: number; ok: boolean; error?: string | null };
const PAD = { l: 44, r: 12, t: 10, b: 22 };

/** Latency over time for one endpoint. Accent line; failed probes (status 0 or not ok) are red markers on
 * the baseline with a label on hover. Crosshair + tooltip (time · status · ms). One y axis. */
export function LatencyChart({ points, height = 200, title }: { points: LinePoint[]; height?: number; title?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const hasPoints = points.length > 0;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const apply = () => { const w = Math.floor(el.clientWidth); if (w > 0) setWidth(w); };
    apply();
    const ro = new ResizeObserver(apply); ro.observe(el);
    return () => ro.disconnect();
  }, [hasPoints]);
  const m = useMemo(() => {
    if (!points.length) return null;
    const t0 = new Date(points[0].at).getTime(), t1 = new Date(points[points.length - 1].at).getTime();
    const span = Math.max(1, t1 - t0);
    const good = points.filter((p) => p.status > 0);
    const maxMs = Math.max(10, ...good.map((p) => p.ms));
    const niceMax = niceCeil(maxMs);
    const w = width - PAD.l - PAD.r, h = height - PAD.t - PAD.b;
    const x = (iso: string) => points.length === 1 ? PAD.l + w / 2 : PAD.l + ((new Date(iso).getTime() - t0) / span) * w;
    const y = (ms: number) => PAD.t + h - (ms / niceMax) * h;
    let d = "", pen = false;
    for (const p of points) { if (p.status === 0) { pen = false; continue; } d += `${pen ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.ms).toFixed(1)}`; pen = true; }
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: niceMax * f, y: y(niceMax * f) }));
    const xTicks = points.length === 1 ? [{ x: x(points[0].at), label: fmtClock(t0, span) }] : [0, 0.5, 1].map((f) => ({ x: PAD.l + f * w, label: fmtClock(t0 + f * span, span) }));
    return { d, x, y, yTicks, xTicks, w, h, base: PAD.t + h };
  }, [points, width, height]);

  if (!m) return <div ref={ref} className="h-[200px] flex items-center justify-center text-[12.5px] text-dim prose">No probes yet for this endpoint.</div>;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const dx = Math.abs(m.x(p.at) - px); if (dx < bd) { bd = dx; best = i; } });
    setHover(best);
  };
  const hp = hover != null ? points[hover] : null;
  const hx = hp ? m.x(hp.at) : 0, hy = hp ? (hp.status === 0 ? m.base : m.y(hp.ms)) : 0;
  const tipLeft = hp ? Math.min(Math.max(hx - 80, PAD.l), width - 172) : 0;
  const tipTop = hp ? Math.max(0, Math.min(hy - 60, height - 70)) : 0;
  const tipTone: Tone = hp ? (hp.status === 0 ? "bad" : !hp.ok ? "bad" : hp.ms > 1500 ? "warn" : "ok") : "neutral";
  const tipState = hp ? (hp.status === 0 ? "unreachable" : !hp.ok ? `failed ${hp.status}` : hp.ms > 1500 ? `slow ${hp.status}` : `ok ${hp.status}`) : "";
  return (
    <div ref={ref} className="relative w-full select-none">
      {title && <div className="text-[12.5px] font-semibold text-text mb-1.5">{title}</div>}
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block cursor-crosshair" role="img" aria-label="Latency over time">
        {m.yTicks.map((t) => <g key={t.v}><line x1={PAD.l} x2={width - PAD.r} y1={t.y} y2={t.y} style={{ stroke: "var(--border)" }} strokeWidth={1} /><text x={PAD.l - 6} y={t.y + 3.5} textAnchor="end" fontSize={10} style={{ fill: "var(--muted)" }}>{fmtMs(t.v)}</text></g>)}
        {m.xTicks.map((t, i) => <text key={i} x={t.x} y={height - 6} textAnchor={i === 0 ? "start" : i === m.xTicks.length - 1 && m.xTicks.length > 1 ? "end" : "middle"} fontSize={10} style={{ fill: "var(--muted)" }}>{t.label}</text>)}
        <path d={m.d} fill="none" style={{ stroke: "var(--accent)" }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.length === 1 && points[0].status > 0 && <circle cx={m.x(points[0].at)} cy={m.y(points[0].ms)} r={3} style={{ fill: "var(--accent)" }} />}
        {points.map((p, i) => (p.status === 0 || !p.ok) && <g key={i}><circle cx={m.x(p.at)} cy={p.status === 0 ? m.base : m.y(p.ms)} r={3.5} style={{ fill: "var(--red)", stroke: "var(--bg)" }} strokeWidth={1.5} /></g>)}
        {hp && <>
          <line x1={hx} x2={hx} y1={PAD.t} y2={m.base} style={{ stroke: "var(--border-strong)" }} strokeWidth={1} strokeDasharray="3 3" />
          <circle cx={hx} cy={hy} r={4} fill="none" style={{ stroke: tipTone === "bad" ? "var(--red)" : "var(--accent)" }} strokeWidth={2} />
        </>}
        {/* wide invisible hit area so the whole plot answers to hover */}
        <rect x={PAD.l} y={PAD.t} width={m.w} height={m.h} fill="transparent" />
      </svg>
      {hp && (
        <div className="absolute pointer-events-none card px-2.5 py-1.5 text-[11.5px] shadow-[var(--shadow-pop)] z-10 w-[160px]" style={{ left: tipLeft, top: tipTop }}>
          <div className="text-dim">{fmtTime(hp.at)}</div>
          <StateLabel tone={tipTone}>{tipState}{hp.status > 0 ? ` · ${fmtMs(hp.ms)}` : ""}</StateLabel>
          {hp.status === 0 && hp.error && <div className="text-muted truncate prose" title={hp.error}>{hp.error}</div>}
        </div>
      )}
    </div>
  );
}

function niceCeil(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return f * p;
}
