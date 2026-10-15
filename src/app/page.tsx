"use client";
// Start — hero (open a folder / analyse a repo), a stat strip, then the projects as cards.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, cx, fmtNum, timeAgo, useApi } from "@/lib/ui";
import { Chip, Icon, Spinner, useToast } from "@/components/ui";
import { BigStat, Headline, Prompt, StandaloneShell, Terminal, TermTabs } from "@/components/shell/standalone";
import { useMe } from "@/lib/me";

type P = { id: string; name: string; slug: string; mode: string; status: string; rootPath: string | null; stack: { summary?: string }; plans: number; lastIndexed: string | null; stats: { endpoints?: number; screens?: number; tables?: number }; dbConnected?: boolean };

export default function Start() {
  const router = useRouter();
  const { data, loading, reload } = useApi<P[]>("/api/projects");
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"folder" | "github">("folder");
  const [repo, setRepo] = useState("");
  const remove = async (p: P) => {
    if (!confirm(`Remove ${p.name} from Arkus? Your code and database are not touched.`)) return;
    setBusy(p.id);
    try { await api(`/api/projects/${p.id}`, { method: "DELETE" }); toast({ title: "Project removed" }); reload(); } finally { setBusy(null); }
  };
  const empty = data && !data.length;
  const totals = (data || []).reduce((t, p) => ({ pages: t.pages + (p.stats?.screens || 0), apis: t.apis + (p.stats?.endpoints || 0), tables: t.tables + (p.stats?.tables || 0) }), { pages: 0, apis: 0, tables: 0 });
  const me = useMe();
  const cloud = !!me?.cloud;
  useEffect(() => { if (cloud) setTab("github"); }, [cloud]);
  const analyse = () => { const u = repo.trim(); if (u) router.push(`/import?url=${encodeURIComponent(u)}`); };

  return (
    <StandaloneShell>
      <div className="flex flex-col gap-12">
        {/* ---------- hero ---------- */}
        <section className="relative flex flex-col items-center gap-8 pt-8">
          <div aria-hidden className="absolute -top-10 left-1/2 -translate-x-1/2 w-[720px] h-[360px] rounded-full pointer-events-none" style={{ background: "radial-gradient(ellipse at center, rgba(52,211,153,.10), transparent 65%)" }} />
          <Headline a="See your whole app." b="Change it safely." sub={cloud ? "Arkus reads your code from GitHub or an uploaded folder, connects to your database, and draws pages → APIs → tables. Your projects are private to your account." : "Arkus reads the code and the database on this machine and draws pages → APIs → tables. Local only; nothing leaves your laptop."} className="relative" />

          <Terminal className="relative w-full max-w-[640px] shadow-[0_24px_64px_rgba(0,0,0,.45)]" right={<TermTabs value={tab} onChange={setTab} items={cloud ? [{ id: "github", label: "github" }, { id: "folder", label: "upload folder" }] : [{ id: "folder", label: "folder" }, { id: "github", label: "github" }]} />}>
            {tab === "folder" ? (
              <Link href={cloud ? "/import?mode=upload" : "/import"} className="group flex items-center gap-3 h-12 px-4 rounded-[7px] border border-border bg-bg-deep hover:border-accent/60 transition text-left">
                <Prompt />
                <span className="font-mono text-[14px] text-text-2 group-hover:text-text transition flex-1 truncate">{cloud ? "Upload a folder from your computer" : "Open a local folder"}<span className="text-dim">…</span></span>
                <span className="font-mono text-[11px] text-dim group-hover:text-accent transition inline-flex items-center gap-1">browse {Icon.chevron({ size: 12 })}</span>
              </Link>
            ) : (
              <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); analyse(); }}>
                <label className="flex-1 flex items-center gap-3 h-12 px-4 rounded-[7px] border border-border bg-bg-deep focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/15 transition">
                  <Prompt />
                  <input autoFocus value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/org/repo" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[14px] text-text placeholder:text-dim" />
                </label>
                <button type="submit" disabled={!repo.trim()} className="btn-primary h-12 px-4 text-[13px] flex-none">Analyse repo {Icon.chevron({ size: 14 })}</button>
              </form>
            )}
          </Terminal>

          <div className="relative flex items-center gap-10 rounded-[14px] border border-border bg-surface/70 px-10 py-5">
            <BigStat value={data ? fmtNum(data.length) : "—"} label="Projects" />
            <span className="w-px h-10 bg-border" />
            <BigStat value={data ? fmtNum(totals.pages) : "—"} label="Pages" />
            <span className="w-px h-10 bg-border" />
            <BigStat value={data ? fmtNum(totals.apis) : "—"} label="APIs" />
          </div>
        </section>

        {/* ---------- projects ---------- */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[.22em] text-dim">Projects</span>
            <span className="flex-1 h-px bg-border" />
            {loading && !data && <span className="flex items-center gap-2 text-[12px] text-muted"><Spinner /> loading</span>}
          </div>

          {empty && (
            <div className="rounded-[10px] border border-dashed border-border-strong px-6 py-10 text-center flex flex-col items-center gap-2">
              <span className="w-9 h-9 rounded-[8px] bg-surface-2 border border-border text-muted flex items-center justify-center">{Icon.map({ size: 17 })}</span>
              <div className="prose text-[15px] font-semibold text-text mt-1">No projects yet</div>
              <div className="prose text-[13px] text-muted max-w-[420px]">{cloud ? "Paste a GitHub repository or upload a folder above. " : "Open a folder or paste a repository above. "}Arkus reads it in place, shows the map and changes nothing.</div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            {data?.map((p) => (
              <article key={p.id} className="group relative card p-4 flex flex-col gap-3 transition hover:border-accent/40 hover:shadow-[0_0_28px_rgba(52,211,153,.10),0_12px_32px_rgba(0,0,0,.4)] min-w-0">
                <Link href={`/p/${p.slug}/overview`} className="absolute inset-0 rounded-[9px]" aria-label={`Open ${p.name}`} />
                <div className="flex items-start gap-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="prose text-[15px] font-semibold text-text truncate group-hover:text-accent transition">{p.name}</div>
                    <div className="text-[12px] text-muted mt-0.5 truncate" title={p.stack?.summary || p.rootPath || undefined}>{p.stack?.summary || <span className="text-dim">not indexed yet</span>}</div>
                  </div>
                  <div className="relative z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition flex-none -mr-1.5 -mt-1">
                    {p.mode === "connected" && p.rootPath && <Link href={`/import?project=${p.slug}`} className="btn-icon btn-xs w-6" title="Re-index">{Icon.refresh({ size: 13 })}</Link>}
                    <button className="btn-icon btn-xs w-auto px-1.5 text-[11px] text-dim hover:text-red-soft" title="Remove from Arkus" disabled={busy === p.id} onClick={() => remove(p)}>{busy === p.id ? <Spinner /> : "Remove"}</button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={p.dbConnected ? "green" : "muted"}>{p.dbConnected ? "db connected" : "no database"}</Chip>
                  {p.status === "indexing" && <Chip tone="amber">indexing</Chip>}
                  {p.status === "error" && <Chip tone="red">error</Chip>}
                  {p.mode === "designed" && <Chip tone="purple">designed</Chip>}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {([["Pages", p.stats?.screens], ["APIs", p.stats?.endpoints], ["Tables", p.stats?.tables]] as const).map(([k, v]) => <div key={k} className="stat-box"><span className="k">{k}</span><span className="v">{v ?? 0}</span></div>)}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-dim font-mono">
                  <span className={cx("w-1.5 h-1.5 rounded-full", p.status === "indexing" ? "bg-amber apulse" : p.lastIndexed ? "bg-accent" : "bg-dim")} />
                  <span className="truncate">{p.lastIndexed ? `indexed ${timeAgo(p.lastIndexed)}` : "never indexed"}</span>
                  <span className="ml-auto text-dim group-hover:text-text transition inline-flex items-center gap-0.5">open {Icon.chevron({ size: 11 })}</span>
                </div>
              </article>
            ))}
            {data && (
              <Link href="/new" className={cx("group rounded-[9px] border border-dashed border-border-strong hover:border-text/40 transition p-4 flex flex-col gap-2 text-left", empty ? "col-span-3 flex-row items-center" : "")}>
                <span className="w-8 h-8 rounded-[7px] bg-surface-2 border border-border text-muted group-hover:text-text flex items-center justify-center transition flex-none">{Icon.spark({ size: 15 })}</span>
                <div className="min-w-0">
                  <div className="prose text-[14px] font-semibold text-text-2 group-hover:text-text transition">Design a new app</div>
                  <div className="text-[12px] text-dim mt-0.5 leading-relaxed">Describe an idea, get a blueprint of tables, APIs and pages, then scaffold it.</div>
                </div>
              </Link>
            )}
          </div>
        </section>

        <p className="font-mono text-[11.5px] text-dim leading-relaxed text-center max-w-[720px] mx-auto">Local-first: Arkus keeps only derived metadata (routes, tables, bindings) in its own SQLite file. Source code is read in place and never copied; database connections are read-only.</p>
      </div>
    </StandaloneShell>
  );
}
