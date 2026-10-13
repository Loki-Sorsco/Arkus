"use client";
// Standalone shell for screens outside the workspace (Start, Import, New): a quiet 48px top bar
// (mark + lowercase wordmark, no nav) over a scrollable body on a dotted grid. Also exports the
// small "terminal" primitives those screens share so they read as one identity.
import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/lib/ui";
import { Icon } from "@/components/ui";
import { signOut, useMe } from "@/lib/me";

export const ArkusMark = ({ size = 24 }: { size?: number }) => (
  <span className="rounded-[6px] bg-accent text-bg-deep inline-flex items-center justify-center flex-none" style={{ width: size, height: size }}>
    <svg width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M9 3v18M15 3v18M3 9h18M3 15h18" /></svg>
  </span>
);

export function StandaloneShell({ title, back, children, right, width = 1040 }: { title?: ReactNode; back?: { href: string; label: string }; children: ReactNode; right?: ReactNode; width?: number }) {
  return (
    <div className="h-screen flex flex-col bg-bg text-text overflow-hidden">
      <header className="h-12 flex-none flex items-center gap-3 px-5 bg-bg border-b border-border">
        <Link href="/" className="flex items-center gap-2 h-8 rounded-[6px] transition hover:opacity-80" title="All projects"><ArkusMark size={20} /><span className="font-mono text-[15px] font-semibold tracking-tight lowercase">arkus</span></Link>
        {back && <><span className="text-dim">/</span><Link href={back.href} className="flex items-center gap-1 text-[12.5px] text-muted hover:text-text transition">{Icon.back({ size: 13 })} {back.label}</Link></>}
        {title && <><span className="text-dim">/</span><span className="text-[12.5px] text-text-2 truncate">{title}</span></>}
        <div className="flex-1" />
        {right && <div className="flex items-center gap-2 flex-none min-w-0">{right}</div>}
        <UserMenu />
      </header>
      <div className="flex-1 min-h-0 overflow-auto relative">
        <div aria-hidden className="absolute inset-0 dots opacity-70 pointer-events-none" style={{ maskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 20%, transparent 100%)", WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 20%, transparent 100%)" }} />
        <div className="relative mx-auto px-6 py-10" style={{ maxWidth: width }}>{children}</div>
      </div>
    </div>
  );
}

/** Big two-tone headline: first line white, second line grey. Sans, like Onboard. */
export function Headline({ a, b, sub, align = "center", size = "lg", className }: { a: ReactNode; b?: ReactNode; sub?: ReactNode; align?: "center" | "left"; size?: "lg" | "md"; className?: string }) {
  return (
    <div className={cx("prose flex flex-col", align === "center" ? "items-center text-center" : "items-start text-left", className)}>
      <h1 className={cx("font-semibold tracking-tight text-text", size === "lg" ? "text-[44px] leading-[1.08]" : "text-[28px] leading-[1.15]")}>
        {a}{b && <><br /><span className="text-muted">{b}</span></>}
      </h1>
      {sub && <p className={cx("text-muted mt-4 leading-relaxed", size === "lg" ? "text-[15.5px] max-w-[560px]" : "text-[14px] max-w-[620px]")}>{sub}</p>}
    </div>
  );
}

/** Tab strip for the terminal header: active tab is a white pill, the rest are dim mono labels. */
export function TermTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="flex items-center gap-1">
      {items.map((it) => (
        <button key={it.id} type="button" onClick={() => onChange(it.id)} className={cx("font-mono text-[11.5px] h-6 px-2.5 rounded-[4px] transition cursor-pointer", value === it.id ? "bg-text text-bg-deep font-semibold" : "text-muted hover:text-text")}>{it.label}</button>
      ))}
    </div>
  );
}

/** Terminal-style box: a thin header strip ("TERMINAL" · tabs/right) over a dark body. */
export function Terminal({ label = "TERMINAL", right, children, className, pad = true, glow }: { label?: string; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean; glow?: boolean }) {
  return (
    <div className={cx("rounded-[10px] border border-border bg-surface overflow-hidden", glow && "glow-soft", className)}>
      <div className="h-10 flex items-center gap-3 px-4 border-b border-border bg-surface-2/60">
        <span className="font-mono text-[10.5px] uppercase tracking-[.22em] text-dim">{label}</span>
        <div className="flex-1" />
        {right}
      </div>
      <div className={cx(pad && "p-4")}>{children}</div>
    </div>
  );
}

/** The `>_` prompt used inside terminal bodies. */
export const Prompt = ({ className }: { className?: string }) => <span className={cx("font-mono text-accent font-semibold select-none flex-none", className)} aria-hidden>&gt;_</span>;

/** Big-number stat in the "1,000+ / DOWNLOADS" style. */
export function BigStat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-[120px]">
      <span className="prose text-[34px] font-semibold tracking-tight text-text leading-none tabular-nums">{value}</span>
      <span className="font-mono text-[10px] uppercase tracking-[.25em] text-dim">{label}</span>
    </div>
  );
}

/** Avatar + sign out (hosted mode only; local mode renders nothing). */
export function UserMenu({ compact }: { compact?: boolean }) {
  const me = useMe();
  if (!me?.cloud || !me.user) return null;
  const u = me.user;
  return (
    <div className="flex items-center gap-2 pl-2 ml-1 border-l border-border">
      {u.image ? <span className="w-5 h-5 rounded-full bg-surface-3 bg-cover bg-center flex-none" style={{ backgroundImage: `url(${u.image})` }} aria-hidden /> : <span className="w-5 h-5 rounded-full bg-surface-3 text-[10px] flex items-center justify-center text-muted">{(u.name || u.email || "?").slice(0, 1).toUpperCase()}</span>}
      {!compact && <span className="text-[12px] text-muted truncate max-w-[160px]" title={u.email || undefined}>{u.name || u.email}</span>}
      <button className="btn-subtle btn-xs" onClick={() => void signOut()} title="Sign out">Sign out</button>
    </div>
  );
}
