"use client";
// New project — Idea → (guided questions) → Blueprint → Infrastructure → Build.
// `?project=<slug>` reopens a designed project at its latest blueprint.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api, cx, useApi } from "@/lib/ui";
import { Chip, Dot, Field, Icon, Spinner, useToast } from "@/components/ui";
import { Headline, Prompt, StandaloneShell, Terminal } from "@/components/shell/standalone";
import { BlueprintView } from "@/components/screens/blueprint";
import { bindingCount, nameFromIdea, type BlueprintGet, type BlueprintResp, type ProjectRef } from "@/components/screens/blueprint-lib";

type Step = "idea" | "blueprint" | "infra" | "build";
type Db = "sqlite" | "postgresql" | "mysql";
type Questions = { questions: { id: string; q: string }[]; aiUsed: boolean; suggestedTemplateLabel?: string };
type Dirs = { dir: string; parent: string | null; home: string; dirs: { path: string; name: string; isProject: boolean }[] };
type Scaffold = { targetDir: string; files: string[]; nextSteps: string[]; version: number };

const STEPS: [Step, string][] = [["idea", "Idea"], ["blueprint", "Blueprint"], ["infra", "Infrastructure"], ["build", "Build"]];
const STACK_CHIPS: [string, string][] = [["Next.js", "Frontend and API routes"], ["PostgreSQL", "Postgres via Prisma (default is SQLite)"], ["Email sign-in", "Email + password sessions"], ["Stripe", "Payments"]];
const EXAMPLES = ["A gym class booking app with memberships, class capacity limits and a waitlist.", "An internal tool where support agents see customer orders and issue refunds.", "A recipe community where people post recipes, save favourites and follow cooks."];
const DBS: { id: Db; name: string; why: string; good: string; warn: string }[] = [
  { id: "sqlite", name: "SQLite", why: "A single file next to the code. Nothing to install, perfect for building locally.", good: "Zero setup · npx prisma db push just works", warn: "Switch to Postgres before real multi-user traffic" },
  { id: "postgresql", name: "PostgreSQL", why: "The production default. Prisma schema targets Postgres; you supply DATABASE_URL.", good: "Real constraints, concurrency, hosted options", warn: "Needs a running Postgres and a DATABASE_URL" },
  { id: "mysql", name: "MySQL", why: "If your team already runs MySQL / MariaDB.", good: "Widely hosted", warn: "Needs a running MySQL and a DATABASE_URL" },
];
const BUILD_STAGES = ["Create the project folder", "Write the database schema", "Generate the APIs", "Generate the pages", "Link fields to keys and columns", "Done"];

export default function NewPage() { return <Suspense><NewProject /></Suspense>; }

function NewProject() {
  const router = useRouter();
  const sp = useSearchParams();
  const existing = sp.get("project");
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("idea");
  const [loadingExisting, setLoadingExisting] = useState(!!existing);
  // idea
  const [idea, setIdea] = useState("");
  const [stack, setStack] = useState<Record<string, boolean>>({ "Next.js": true });
  const [questions, setQuestions] = useState<Questions | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [projName, setProjName] = useState("");
  const [busy, setBusy] = useState<"questions" | "generate" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // blueprint
  const [project, setProject] = useState<ProjectRef | null>(null);
  const [bp, setBp] = useState<BlueprintResp | null>(null);
  const [reveal, setReveal] = useState(false);
  // infra
  const [db, setDb] = useState<Db>("sqlite");
  const [dir, setDir] = useState("");
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("");
  const listing = useApi<Dirs>(step === "infra" ? `/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}` : null);
  // build
  const [stage, setStage] = useState(-1);
  const [built, setBuilt] = useState<Scaffold | null>(null);
  const [buildErr, setBuildErr] = useState<{ message: string; notEmpty: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const selfCreated = useRef(false); // set when this page created the project itself, so the ?project= rewrite doesn't reload it

  // reopen an existing designed project
  useEffect(() => {
    if (!existing || selfCreated.current) return;
    (async () => {
      try {
        const p = await api<{ id: string; slug: string; name: string }>(`/api/projects/${existing}`);
        const ref = { id: p.id, slug: p.slug, name: p.name };
        setProject(ref); setProjName(p.name);
        const g = await api<BlueprintGet>(`/api/projects/${p.id}/blueprint`);
        if (g.blueprint) { setBp({ blueprint: g.blueprint, version: g.version, checks: g.checks, aiUsed: (g as { aiUsed?: boolean }).aiUsed ?? true, template: (g as { template?: string | null }).template ?? null, issues: g.issues }); setStep("blueprint"); }
        if (g.prompt) setIdea(g.prompt.split("\n")[0]);
      } catch (e) { toast({ title: "Couldn't open that project", detail: (e as Error).message, kind: "error" }); }
      finally { setLoadingExisting(false); }
    })();
  }, [existing, toast]);
  useEffect(() => { if (listing.data && !parent) setParent(listing.data.dir); }, [listing.data, parent]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const stackHint = Object.keys(stack).filter((k) => stack[k]).join(", ") || undefined;
  const askQuestions = async () => {
    if (idea.trim().length < 4) { setErr("Say a little more — one or two sentences is plenty."); return; }
    setErr(null); setBusy("questions");
    try { const q = await api<Questions>("/api/architect/questions", { json: { idea: idea.trim() } }); setQuestions(q); if (!projName) setProjName(nameFromIdea(idea)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const generate = async (withAnswers: boolean) => {
    setErr(null); setBusy("generate");
    try {
      let ref = project;
      if (!ref) { const p = await api<{ id: string; slug: string; name: string }>("/api/projects", { json: { mode: "designed", name: projName.trim() || nameFromIdea(idea) } }); ref = { id: p.id, slug: p.slug, name: p.name }; setProject(ref); }
      const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
      const r = await api<BlueprintResp>(`/api/projects/${ref.id}/blueprint`, { json: { idea: idea.trim(), ...(withAnswers && Object.keys(filled).length ? { answers: filled } : {}), ...(stackHint ? { stackHint } : {}) } });
      setBp(r); setReveal(true); setStep("blueprint"); setQuestions(null);
      setFolder(ref.slug);
      selfCreated.current = true;
      router.replace(`/new?project=${ref.slug}`);
      const n = r.blueprint.entities.length + r.blueprint.endpoints.length + r.blueprint.pages.length;
      setTimeout(() => setReveal(false), Math.min(n, 40) * 55 + 700);
      if (!r.aiUsed) toast({ title: "Built from the offline template", detail: "Add a Groq key under Settings → AI for an AI-designed blueprint.", kind: "warn" });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const sep = parent.includes("\\") ? "\\" : "/";
  const targetDir = parent && folder ? `${parent.replace(/[\\/]+$/, "")}${sep}${folder.trim()}` : "";
  const build = async (force = false) => {
    if (!project || !bp) return;
    setStep("build"); setStage(0); setBuilt(null); setBuildErr(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/blueprint/scaffold`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetDir, database: db, ...(force ? { force: true } : {}) }) });
      const json = (await res.json().catch(() => ({}))) as Partial<Scaffold> & { error?: string; message?: string };
      if (!res.ok) { setBuildErr({ message: json.message || json.error || res.statusText, notEmpty: res.status === 409 }); return; }
      let s = 1; setStage(1);
      timer.current = setInterval(() => { s++; setStage(s); if (s >= BUILD_STAGES.length - 1) { clearInterval(timer.current!); timer.current = null; setBuilt(json as Scaffold); } }, 480);
    } catch (e) { setBuildErr({ message: (e as Error).message, notEmpty: false }); }
  };

  const si = STEPS.findIndex(([s]) => s === step);
  const name = bp?.blueprint.name || project?.name || "New project";
  const canGoTo = (i: number) => i < si && !(step === "build" && !built && !buildErr);

  const stepper = (
    <div className="flex items-center gap-1">
      {STEPS.map(([id, label], i) => (
        <div key={id} className="flex items-center gap-1">
          <button disabled={!canGoTo(i)} onClick={() => setStep(id)} className={cx("flex items-center gap-1.5 h-7 px-1.5 rounded-[5px] font-mono text-[11.5px] lowercase disabled:cursor-default", i === si ? "text-text font-semibold" : i < si ? "text-muted cursor-pointer hover:text-text" : "text-dim")}>
            <span className={cx("w-[18px] h-[18px] rounded-full inline-flex items-center justify-center text-[10.5px] font-semibold border", i === si ? "border-accent text-accent" : i < si ? "border-border-strong text-text-2" : "border-border text-dim")}>{i < si ? Icon.check({ size: 10 }) : i + 1}</span>{label}
          </button>
          {i < STEPS.length - 1 && <span className="w-4 h-px bg-border" />}
        </div>
      ))}
    </div>
  );

  return (
    <StandaloneShell title={step === "idea" && !project ? undefined : name} back={{ href: "/", label: "Projects" }} right={stepper} width={step === "blueprint" ? 1280 : step === "infra" ? 920 : 720}>
      {loadingExisting && <div className="flex items-center justify-center gap-2 text-muted py-20"><Spinner /> Opening the blueprint</div>}

      {/* ---------- IDEA ---------- */}
      {!loadingExisting && step === "idea" && (
        <div className="flex flex-col gap-6">
          <Headline size="md" align="left" a="What are you building?" b="Describe it; Arkus drafts the blueprint." sub="A sentence or two is enough. Arkus designs the database, APIs and pages, shows you the blueprint, and builds it once you approve." />
          {!questions ? (
            <>
              <Terminal label="Your idea">
                <div className="flex flex-col gap-4">
                  <div className="flex items-start gap-3 rounded-[7px] border border-border bg-bg-deep px-3.5 py-3 focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/15 transition">
                    <Prompt className="mt-[3px]" />
                    <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} placeholder="A booking app for…" className="flex-1 min-w-0 bg-transparent outline-none resize-y font-mono text-[14px] leading-relaxed text-text placeholder:text-dim" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) askQuestions(); }} />
                  </div>
                  <div>
                    <div className="label">Stack</div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      {STACK_CHIPS.map(([label, title]) => (
                        <label key={label} className="flex items-center gap-2 text-[13px] text-text-2 cursor-pointer"><input type="checkbox" checked={!!stack[label]} onChange={() => setStack((s) => ({ ...s, [label]: !s[label] }))} /><span className="whitespace-nowrap">{label}</span><span className="text-[12px] text-dim truncate">{title}</span></label>
                      ))}
                    </div>
                  </div>
                  {err && <div className="text-[13px] text-red-soft bg-red/10 border border-red/30 rounded-[6px] px-3 py-2">{err}</div>}
                  <div className="flex items-center gap-3"><button className="btn-primary h-9 px-4" disabled={!!busy || idea.trim().length < 4} onClick={askQuestions}>{busy ? <Spinner /> : <>Generate blueprint {Icon.chevron({ size: 14 })}</>}</button><span className="font-mono text-[11.5px] text-dim">Ctrl/Cmd + Enter</span></div>
                </div>
              </Terminal>
              <Terminal label="Or start from an example" pad={false}>
                {EXAMPLES.map((t) => <div key={t} onClick={() => { setIdea(t); setErr(null); }} className={cx("list-row border-b border-border/60 last:border-b-0 gap-3", idea === t && "active")}><Prompt className="text-[12px]" /><span className="truncate">{t}</span></div>)}
              </Terminal>
              <span className="font-mono text-[11.5px] text-dim">Already have an app? <Link href="/import" className="link">Open a local folder instead</Link></span>
            </>
          ) : (
            <Terminal label="A few quick questions" right={<>{questions.suggestedTemplateLabel && <Chip tone="purple">starts from {questions.suggestedTemplateLabel}</Chip>}{!questions.aiUsed && <Chip tone="muted" title="Add a Groq key under Settings → AI for questions tailored to your idea">AI offline</Chip>}</>} className="arise">
              <div className="flex flex-col gap-4">
                <div className="text-[12.5px] text-muted">Answer what you know and leave the rest blank. The more specific, the better the blueprint.</div>
                <Field label="Project name"><input className="input" value={projName} onChange={(e) => setProjName(e.target.value)} placeholder={nameFromIdea(idea)} /></Field>
                {questions.questions.map((q) => <Field key={q.id} label={q.q}><input className="input" value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && generate(true)} /></Field>)}
                {err && <div className="text-[13px] text-red-soft bg-red/10 border border-red/30 rounded-[6px] px-3 py-2">{err}</div>}
                <div className="flex items-center gap-2">
                  <button className="btn-primary" disabled={!!busy} onClick={() => generate(true)}>{busy === "generate" ? <><Spinner /> Designing</> : <>Generate blueprint {Icon.chevron({ size: 14 })}</>}</button>
                  <button className="btn-ghost" disabled={!!busy} onClick={() => generate(false)}>Skip, just generate</button>
                  <button className="btn-subtle ml-auto" disabled={!!busy} onClick={() => setQuestions(null)}>{Icon.back({ size: 14 })} Edit the idea</button>
                </div>
              </div>
            </Terminal>
          )}
        </div>
      )}

      {/* ---------- BLUEPRINT ---------- */}
      {!loadingExisting && step === "blueprint" && project && bp && (
        <BlueprintView project={project} data={bp} reveal={reveal} engine={db} onUpdate={(r) => setBp((prev) => ({ ...r, template: r.template ?? prev?.template }))}
          footer={<button className="btn-primary" onClick={() => { if (!folder) setFolder(project.slug); setStep("infra"); }}>Choose infrastructure {Icon.chevron({ size: 14 })}</button>} />
      )}

      {/* ---------- INFRASTRUCTURE ---------- */}
      {step === "infra" && project && bp && (
        <div className="flex flex-col gap-6">
          <Headline size="md" align="left" a={`Where ${name} will run.`} b="Pick a database and a folder you own." sub={<>Arkus writes a real Next.js + Prisma repo from the blueprint: {bp.blueprint.entities.length} tables, {bp.blueprint.endpoints.length} APIs and {bp.blueprint.pages.length} pages, with {bindingCount(bp.blueprint)} field bindings.</>} />
          <Terminal label="Database">
            <div className="grid grid-cols-3 gap-4">
              {DBS.map((d) => (
                <button key={d.id} onClick={() => setDb(d.id)} className={cx("text-left p-4 rounded-[6px] border flex flex-col gap-2 cursor-pointer transition bg-bg-deep/30", db === d.id ? "border-accent" : "border-border hover:border-border-strong")}>
                  <div className="flex items-center gap-2"><span className="text-[13.5px] font-semibold">{d.name}</span><span className="text-[12px] text-dim">via Prisma</span>{d.id === "sqlite" && <Chip tone="muted" className="ml-auto">recommended</Chip>}</div>
                  <div className="text-[12.5px] text-muted leading-relaxed">{d.why}</div>
                  <div className="text-[12px] text-green flex items-start gap-1.5">{Icon.check({ size: 12, className: "mt-[3px] flex-none" })}<span>{d.good}</span></div>
                  <div className="text-[12px] text-amber flex items-start gap-1.5">{Icon.warn({ size: 12, className: "mt-[3px] flex-none" })}<span>{d.warn}</span></div>
                </button>
              ))}
            </div>
          </Terminal>
          <Terminal label="Folder">
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <button className="btn-icon btn-sm" disabled={!listing.data?.parent} onClick={() => setDir(listing.data!.parent!)} title="Up one level"><span className="rotate-90 inline-flex">{Icon.back({ size: 14 })}</span></button>
                <span className="font-mono truncate text-text-2">{listing.data?.dir || "…"}</span>
                <div className="flex-1" />
                <button className="btn-subtle btn-sm" onClick={() => setDir(listing.data?.home || "")}>Home</button>
                <button className="btn-ghost btn-sm" disabled={!listing.data} onClick={() => setParent(listing.data!.dir)}>Use this folder</button>
              </div>
              <div className="border border-border rounded-[6px] max-h-[216px] overflow-auto bg-bg-deep/40">
                {listing.loading && <div className="p-3"><Spinner /></div>}
                {listing.data?.dirs.map((d) => <div key={d.path} onClick={() => setParent(d.path)} onDoubleClick={() => setDir(d.path)} className={cx("list-row group border-b border-border/50 last:border-b-0", parent === d.path && "active")}><span className={d.isProject ? "text-text-2" : "text-dim"}>{Icon.folder({ size: 15 })}</span><span className={cx("truncate", d.isProject && "text-text")}>{d.name}</span>{d.isProject && <Chip tone="teal">project</Chip>}<span className="ml-auto text-[11.5px] text-dim opacity-0 group-hover:opacity-100 transition">double-click to open</span></div>)}
                {listing.data && !listing.data.dirs.length && <div className="p-4 text-[13px] text-dim">No sub-folders here.</div>}
              </div>
              <div className="grid grid-cols-[1fr_240px] gap-4">
                <Field label="Parent folder"><input className="input font-mono" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="C:\Users\you\code" /></Field>
                <Field label="New folder name"><input className="input font-mono" value={folder} onChange={(e) => setFolder(e.target.value)} /></Field>
              </div>
              <div className="text-[12.5px] text-dim">Arkus will create <span className="font-mono text-text-2">{targetDir || "…"}</span>. It must be new or empty; nothing else on disk is touched.</div>
            </div>
          </Terminal>
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-muted">{DBS.find((d) => d.id === db)!.name} · Next.js App Router · Prisma · {bp.blueprint.endpoints.length} routes · {bp.blueprint.pages.length} pages</span>
            <div className="flex-1" /><button className="btn-ghost" onClick={() => setStep("blueprint")}>{Icon.back({ size: 14 })} Blueprint</button><button className="btn-primary" disabled={!targetDir || folder.trim().length < 1} onClick={() => build(false)}>Build {name} {Icon.chevron({ size: 14 })}</button>
          </div>
        </div>
      )}

      {/* ---------- BUILD ---------- */}
      {step === "build" && project && bp && (
        <div className="flex flex-col gap-6">
          <Headline size="md" align="left" a={built ? `${name} is ready.` : buildErr ? "Build stopped." : `Building ${name}.`} b="Everything goes into a folder you own." sub="You can leave with the code at any time." />
          <Terminal pad={false}>
            {BUILD_STAGES.map((label, i) => {
              const done = i < stage || !!built, run = i === stage && !built && !buildErr, failed = !!buildErr && i === stage;
              const detail = [targetDir, `prisma/schema.prisma · ${bp.blueprint.entities.length} models · ${db}`, `${bp.blueprint.endpoints.length} endpoints with zod validation and Prisma calls`, `${bp.blueprint.pages.length} pages with forms bound to their endpoints`, `${bindingCount(bp.blueprint)} bindings recorded in the stack graph (arkus.json)`, built ? `${built.files.length} files written · blueprint v${built.version}` : ""][i];
              return (
                <div key={label} className="flex items-center gap-3 px-4 py-2.5 border-b border-border/60 last:border-b-0">
                  <span className="w-4 flex justify-center">{done ? <span className="text-green">{Icon.check({ size: 14 })}</span> : failed ? <span className="text-red-soft">{Icon.close({ size: 14 })}</span> : run ? <Spinner /> : <Dot color="muted" />}</span>
                  <div className="flex-1 min-w-0 flex flex-col"><span className={cx("text-[13px] font-medium", done || run ? "text-text" : "text-dim")}>{label}</span>{(done || run || failed) && detail && <span className="text-[12px] text-dim truncate font-mono">{detail}</span>}</div>
                </div>
              );
            })}
          </Terminal>
          {buildErr && (
            <Terminal label="Error" className="border-red/40 arise">
              <div className="flex flex-col gap-3">
                <div className="text-[13px] text-red-soft">{buildErr.message}</div>
                <div className="flex gap-2">
                  {buildErr.notEmpty && <button className="btn-primary" onClick={() => build(true)}>Overwrite the folder</button>}
                  <button className="btn-ghost" onClick={() => { setStep("infra"); setStage(-1); setBuildErr(null); }}>{Icon.back({ size: 14 })} Change the folder</button>
                </div>
              </div>
            </Terminal>
          )}
          {built && (
            <div className="flex flex-col gap-4 arise">
              <Terminal label="Next steps in your terminal"><div className="flex flex-col gap-1.5 font-mono text-[12.5px]">{built.nextSteps.map((s, i) => <div key={i} className="text-text-2 flex gap-3"><Prompt className="text-[12px]" /><span>{s}</span></div>)}</div></Terminal>
              <div className="flex items-center gap-2">
                <button className="btn-primary" onClick={() => router.push(`/import?project=${project.slug}`)}>Analyse the code {Icon.chevron({ size: 14 })}</button>
                <button className="btn-ghost" onClick={() => router.push(`/p/${project.slug}/overview`)}>Open the workspace</button>
                <span className="text-[12px] text-dim ml-1">Analysing indexes the new repo so the map shows pages, APIs and tables.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </StandaloneShell>
  );
}
