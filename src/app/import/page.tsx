"use client";
// Import — pick a folder (default) or a git URL, then watch the analysis stream
// (read files → scrub secrets → detect stack → extract → link → save).
// `?project=<slug>` re-indexes an existing project; `?url=<repo>` prefills the Git URL tab.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ApiError, api, cx, streamEvents, useApi } from "@/lib/ui";
import { Chip, Dot, Field, Icon, Spinner, Toggle } from "@/components/ui";
import { BigStat, Headline, Prompt, StandaloneShell, Terminal, TermTabs } from "@/components/shell/standalone";
import { useMe } from "@/lib/me";
import { UploadFolder } from "@/components/screens/upload-folder";
import { GithubSaved, GithubTokenField, useGithubAccess } from "@/components/screens/github-access";

type Log = { t: number; stage: string; msg: string; level: "info" | "warn" | "error" | "done" };
type Dirs = { dir: string; parent: string | null; home: string; dirs: { path: string; name: string; isProject: boolean }[] };
const STAGES = [["clone", "Read files"], ["scrub", "Scrub secrets"], ["detect", "Detect stack"], ["extract", "Extract routes & models"], ["resolve", "Link bindings"], ["persist", "Save map"], ["done", "Done"]] as const;

export default function ImportPage() { return <Suspense><Import /></Suspense>; }

function Import() {
  const router = useRouter();
  const sp = useSearchParams();
  const existing = sp.get("project");
  const prefillUrl = sp.get("url") || "";
  const wantMode = sp.get("mode");
  const [mode, setMode] = useState<"folder" | "git" | "upload">(wantMode === "upload" ? "upload" : prefillUrl ? "git" : "folder");
  const me = useMe();
  const cloud = !!me?.cloud;
  useEffect(() => { if (cloud) setMode((m) => (m === "folder" ? (prefillUrl ? "git" : "upload") : m)); }, [cloud, prefillUrl]);
  const [dir, setDir] = useState<string>("");
  const [picked, setPicked] = useState<string>("");
  const [gitUrl, setGitUrl] = useState(prefillUrl);
  const [priv, setPriv] = useState(false);
  const [draft, setDraft] = useState<{ token: string; remember: boolean }>({ token: "", remember: true });
  const gh = useGithubAccess();
  const [name, setName] = useState("");
  const [log, setLog] = useState<Log[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<{ stats: Record<string, number>; unresolved: { message: string; kind: string }[]; slug: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listing = useApi<Dirs>(cloud ? null : `/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [log]);

  const run = async (slugOrId: string) => {
    setBusy(true); setLog([]); setErr(null); setStage("clone");
    const p = await api<{ slug: string }>(`/api/projects/${slugOrId}`);
    const s = streamEvents(`/api/projects/${slugOrId}/index`, {
      log: (d) => { const l = d as Log; setLog((x) => [...x, l]); setStage(l.stage); },
      done: (d) => { const r = d as { stats: Record<string, number>; unresolved: { message: string; kind: string }[] }; setResult({ ...r, slug: p.slug }); setStage("done"); },
      error: (d) => setErr((d as { message: string }).message),
    });
    await s.done; setBusy(false);
  };
  useEffect(() => { if (existing) run(existing); }, [existing]);

  const start = async () => {
    setErr(null); setBusy(true);
    try {
      const tok = priv && !gh.data?.configured && draft.token.trim() ? { token: draft.token.trim(), rememberToken: draft.remember } : {};
      const body = mode === "folder" ? { mode: "connected", rootPath: picked, name: name || undefined } : { mode: "connected", repoUrl: gitUrl, name: name || undefined, ...tok };
      const p = await api<{ id: string; slug: string }>("/api/projects", { json: body });
      if (tok.token && tok.rememberToken) { setDraft({ token: "", remember: true }); gh.reload(true); }
      await run(p.slug);
    } catch (e) {
      setErr((e as Error).message); setBusy(false);
      if (e instanceof ApiError && e.status === 401) setPriv(true); // GitHub asked for credentials: open the private option
    }
  };

  const stageIdx = STAGES.findIndex(([s]) => s === stage);
  const done = stage === "done";
  const progress = done ? 100 : stage ? Math.round(((stageIdx + 0.5) / (STAGES.length - 1)) * 100) : 0;
  const canStart = !busy && mode !== "upload" && (mode === "folder" ? !!picked : !!gitUrl && !(priv && !gh.data?.configured && !draft.token.trim()));

  return (
    <StandaloneShell back={{ href: "/", label: "Projects" }} width={820}>
      <div className="flex flex-col gap-8">
        <Headline size="md" align="left"
          a={existing ? "Re-indexing." : "Import an existing app."}
          b={existing ? "Reading the code again." : "Arkus reads it in place."}
          sub={existing ? "The map is rebuilt from the current code. Confirmed bindings and notes are kept." : "Secrets are never read, nothing is modified, and you can remove the project any time."} />

        {!stage && (
          <Terminal label="Source" right={<TermTabs value={mode} onChange={setMode} items={cloud ? [{ id: "upload", label: "upload folder" }, { id: "git", label: "git url" }] : [{ id: "folder", label: "folder" }, { id: "git", label: "git url" }]} />}>
            <div className="flex flex-col gap-4">
              {mode === "upload" ? (
                <UploadFolder onDone={(slug) => { setErr(null); setBusy(true); void run(slug); }} />
              ) : mode === "folder" ? (
                <>
                  <div className="flex items-center gap-2 text-[12.5px] text-muted">
                    <button className="btn-icon btn-sm" disabled={!listing.data?.parent} onClick={() => setDir(listing.data!.parent!)} title="Up one level"><span className="rotate-90 inline-flex">{Icon.back({ size: 14 })}</span></button>
                    <Prompt className="text-[12px]" />
                    <span className="font-mono truncate text-text-2">{listing.data?.dir || "…"}</span>
                    <div className="flex-1" />
                    <button className="btn-subtle btn-sm" onClick={() => setDir(listing.data?.home || "")}>Home</button>
                  </div>
                  <div className="border border-border rounded-[7px] max-h-[288px] overflow-auto bg-bg-deep">
                    {listing.loading && <div className="p-3"><Spinner /></div>}
                    {listing.data?.dirs.map((d) => (
                      <div key={d.path} onClick={() => setPicked(d.path)} onDoubleClick={() => setDir(d.path)} className={cx("list-row group border-b border-border/50 last:border-b-0", picked === d.path && "active")}>
                        <span className={d.isProject ? "text-text-2" : "text-dim"}>{Icon.folder({ size: 15 })}</span>
                        <span className={cx("truncate font-mono text-[12.5px]", d.isProject ? "text-text" : "")}>{d.name}</span>
                        {d.isProject && <Chip tone="teal">project</Chip>}
                        <span className="ml-auto text-[11px] text-dim opacity-0 group-hover:opacity-100 transition">double-click to open</span>
                      </div>
                    ))}
                    {listing.data && !listing.data.dirs.length && <div className="p-4 text-[13px] text-dim">No sub-folders here.</div>}
                  </div>
                  <Field label="Project folder" hint="Pick a folder above or paste its path.">
                    <label className="flex items-center gap-3 h-11 px-3.5 rounded-[7px] border border-border bg-bg-deep focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/15 transition">
                      <Prompt className="text-[12px]" />
                      <input className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[13.5px] text-text placeholder:text-dim" value={picked} onChange={(e) => setPicked(e.target.value)} placeholder="C:\Users\you\code\my-app" spellCheck={false} />
                    </label>
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Repository URL" hint="Cloned shallowly into Arkus's own .repos folder; nothing is pushed.">
                    <label className="flex items-center gap-3 h-12 px-3.5 rounded-[7px] border border-border bg-bg-deep focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/15 transition">
                      <Prompt />
                      <input autoFocus={!prefillUrl} className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[14px] text-text placeholder:text-dim" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/org/repo.git" spellCheck={false} />
                    </label>
                  </Field>
                  {gh.data?.configured ? (
                    <GithubSaved info={gh.data} onForget={async () => { await api("/api/settings/github", { method: "DELETE" }); await gh.reload(true); }} />
                  ) : (
                    <>
                      <Toggle checked={priv} onChange={setPriv} label="Private repository" hint={priv ? undefined : <>Needs a GitHub token with read access. Public repositories need nothing.</>} />
                      {priv && <div className="pl-[42px]"><GithubTokenField onDraft={setDraft} /></div>}
                    </>
                  )}
                </>
              )}
              <div className="flex items-end gap-3 border-t border-border/60 mt-1 pt-4">
                <div className="flex-1 max-w-[360px]"><Field label="Project name (optional)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="defaults to the folder name" /></Field></div>
                <div className="flex-1" />
                <button className="btn-primary h-9 px-4" disabled={!canStart} onClick={start}>{busy ? <Spinner /> : <>Analyse {Icon.chevron({ size: 14 })}</>}</button>
              </div>
              {err && <div className="font-mono text-[12.5px] text-red-soft bg-red/10 border border-red/30 rounded-[6px] px-3 py-2">{err}</div>}
            </div>
          </Terminal>
        )}

        {stage && (
          <Terminal pad={false} right={<span className={cx("font-mono text-[11px] uppercase tracking-[.18em] tabular-nums", done ? "text-accent" : err ? "text-red-soft" : "text-muted")}>{done ? "complete" : err ? "stopped" : `${progress}%`}</span>}>
            <div className="px-4 pt-3 pb-3 flex flex-col gap-3 border-b border-border">
              <div className="h-1 rounded-full bg-surface-3 overflow-hidden"><div className={cx("h-full transition-all duration-300", err && !done ? "bg-red" : "bg-accent")} style={{ width: `${progress}%` }} /></div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {STAGES.map(([id, label], i) => {
                  const state = done || i < stageIdx ? "done" : i === stageIdx ? (err ? "fail" : "run") : "todo";
                  return <span key={id} className={cx("inline-flex items-center gap-1.5 font-mono text-[11.5px] whitespace-nowrap", state === "done" ? "text-accent" : state === "run" ? "text-text" : state === "fail" ? "text-red-soft" : "text-dim")}>{state === "done" ? Icon.check({ size: 12 }) : state === "run" ? <Spinner className="w-3 h-3" /> : state === "fail" ? Icon.close({ size: 12 }) : <Dot color="muted" />}{label}{i < STAGES.length - 1 && <span className="w-3 h-px bg-border ml-1" />}</span>;
                })}
              </div>
            </div>
            <div ref={logRef} className="max-h-[320px] overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.75] bg-bg-deep">
              {log.map((l, i) => (
                <div key={i} className={cx("flex gap-3 arise", l.level === "warn" ? "text-amber" : l.level === "error" ? "text-red-soft" : l.level === "done" ? "text-accent" : "text-text-2")}>
                  <span className="text-dim w-[64px] flex-none tabular-nums">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
                  <Prompt className={cx("text-[12px]", l.level === "warn" ? "text-amber" : l.level === "error" ? "text-red-soft" : "")} />
                  <span className="text-dim w-14 flex-none">{l.stage}</span>
                  <span className="break-words min-w-0">{l.msg}</span>
                </div>
              ))}
              {!log.length && !err && <div className="flex gap-3 text-dim"><Prompt className="text-[12px]" /><span className="apulse">waiting for the first event</span></div>}
              {err && <div className="text-red-soft flex gap-2 items-start mt-1">{Icon.warn({ size: 14, className: "mt-1 flex-none" })}<span>{err}</span></div>}
            </div>
            {result && (
              <div className="px-4 py-5 border-t border-border flex flex-col gap-5 arise">
                <div className="flex gap-2 flex-wrap justify-center">
                  {([["screens", "Pages"], ["endpoints", "APIs"], ["tables", "Tables"], ["bindings", "Bindings"], ["externals", "Services"]] as const).map(([k, l]) => <BigStat key={k} label={l} value={result.stats[k] ?? 0} />)}
                  {result.unresolved.length > 0 && <BigStat label="Unresolved" value={<span className="text-amber">{result.unresolved.length}</span>} />}
                </div>
                {result.unresolved.length > 0 && (
                  <details className="text-[12.5px]">
                    <summary className="cursor-pointer text-muted hover:text-text w-fit">What could not be resolved</summary>
                    <div className="flex flex-col gap-1.5 mt-2">
                      {result.unresolved.slice(0, 6).map((u, i) => <div key={i} className="flex items-start gap-2 text-text-2"><Chip tone="amber">{u.kind.replace(/_/g, " ")}</Chip><span>{u.message}</span></div>)}
                      {result.unresolved.length > 6 && <span className="text-dim">+{result.unresolved.length - 6} more</span>}
                    </div>
                  </details>
                )}
                <div className="flex gap-2 justify-center"><button className="btn-primary h-9 px-4" onClick={() => router.push(`/p/${result.slug}/overview`)}>Open the map {Icon.chevron({ size: 14 })}</button><button className="btn-ghost h-9 px-4" onClick={() => router.push(`/p/${result.slug}/connect`)}>Connect the database</button></div>
              </div>
            )}
            {err && !result && <div className="px-4 py-3 border-t border-border flex gap-2"><button className="btn-ghost" onClick={() => { setStage(null); setBusy(false); }}>Back</button></div>}
          </Terminal>
        )}

        <details className="font-mono text-[11.5px] text-dim">
          <summary className="cursor-pointer hover:text-muted w-fit">Supported stacks</summary>
          <p className="mt-1 leading-relaxed">Next.js (App & Pages router, server actions), Express, Fastify, Hono, NestJS, tRPC, FastAPI, Flask, Django · Prisma, Drizzle, SQL migrations, SQLAlchemy, Django models · OpenAPI files · fetch/axios/react-query callers.</p>
        </details>
      </div>
    </StandaloneShell>
  );
}
