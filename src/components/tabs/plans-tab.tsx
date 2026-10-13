"use client";
// Plans tab: the plan picked in the side panel (tab.key = plan number). Pipeline draft → previewing →
// checks passing → approved → shipped (+ failed). Free path: "Hand off" (precise guide + copy-as-AI-prompt)
// instead of Arkus shipping the code. Change rows with file:line open the file.
import { useEffect, useState } from "react";
import type { Tab } from "@/components/shell/tabs";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { layerTone, pipelineTone, usePlans, type Plan } from "@/components/panels/plans";
import { Chip, CopyButton, Dot, EmptyState, Icon, Markdown, Panel, Spinner, useToast } from "@/components/ui";
import { api, cx, timeAgo } from "@/lib/ui";

const STEPS: [string, string][] = [["draft", "Draft"], ["previewing", "Previewing"], ["checks_passing", "Checks passing"], ["approved", "Approved"], ["shipped", "Shipped"]];
const stepIdx = (p: string) => Math.max(0, STEPS.findIndex(([s]) => s === p));
const promptOf = (guide: string) => { const m = /```\n([\s\S]*?)```\s*$/.exec(guide); return m ? m[1] : guide; };

export function PlansTab({ tab }: { tab: Tab }) {
  const { project, reloadProject, env, gate, reloadGraph, openFile, openTab, updateTab } = useWorkspace();
  const { toast } = useToast();
  const list = usePlans();
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const no = tab.key ? Number(tab.key) : null;
  const plan = list.data?.find((p) => p.no === no) || list.data?.[0] || null;
  // No (or stale) selection: fall back to the first plan and record it so the side panel highlights it.
  useEffect(() => { if (plan && String(plan.no) !== tab.key) updateTab(tab.id, { key: String(plan.no) }); }, [plan, tab.id, tab.key, updateTab]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!plan) return;
    setBusy(action);
    try {
      const r = await api<Plan & { verify?: { done: number; total: number } }>(`/api/projects/${project.slug}/plans/${plan.no}`, { method: "PATCH", json: { action, ...extra } });
      await list.reload(true); await reloadProject();
      if (action === "verify") toast({ title: r.verify?.done === r.verify?.total ? "All steps found in the repo — shipped" : `${r.verify?.done ?? 0} of ${r.verify?.total ?? 0} steps complete`, kind: r.verify?.done === r.verify?.total ? "ok" : "info" });
      else if (action === "preview") toast({ title: r.pipeline === "checks_passing" ? "Checks passing" : "A check failed", detail: r.checks.filter((c) => c.status === "fail").map((c) => c.name).join(", ") || undefined, kind: r.pipeline === "checks_passing" ? "ok" : "warn" });
      else if (action === "approve") toast({ title: "Approved — hand-off guide is ready", kind: "ok" });
    } catch (e) { toast({ title: "Couldn't do that", detail: (e as Error).message, kind: "error" }); }
    setBusy(null);
  };

  if (!plan) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {list.loading && !list.data ? <div className="flex-1 flex items-center justify-center"><Spinner /></div>
          : <EmptyState icon={Icon.spark()} title={list.data?.length ? "Pick a plan" : "No plans yet"} hint={list.data?.length ? "Choose a plan on the left to review its changes, checks and hand-off guide." : "Add a field on a page or a column on a table, then Save to plan; it lands here for review."} action={!list.data?.length ? <button className="btn-primary" onClick={() => openTab({ kind: "map", label: "Map" })}>Open the map</button> : undefined} />}
      </div>
    );
  }

  const primary = (plan.pipeline === "draft" || plan.pipeline === "failed") ? <button className="btn-primary btn-xs" disabled={!!busy} onClick={() => act("preview")}>{busy === "preview" ? <Spinner /> : Icon.play({ size: 13 })} Preview</button>
    : plan.pipeline === "checks_passing" ? <button className="btn-primary btn-xs" disabled={!!busy} onClick={() => gate(() => act("approve", { confirm: project.name }))}>{busy === "approve" ? <Spinner /> : Icon.check({ size: 13 })} Approve</button>
    : plan.pipeline === "approved" ? <button className="btn-primary btn-xs" disabled={!!busy} onClick={async () => { await reloadGraph(); act("verify"); }}>{busy === "verify" ? <Spinner /> : Icon.git({ size: 13 })} Verify in repo</button>
    : plan.pipeline === "previewing" ? <button className="btn-ghost btn-xs" disabled={!!busy} onClick={() => act("preview")}>{busy === "preview" ? <Spinner /> : Icon.refresh({ size: 13 })} Re-run checks</button>
    : null;
  const secondary = plan.pipeline === "failed" ? <button className="btn-subtle btn-xs" onClick={() => act("reopen")}>Reopen</button>
    : plan.pipeline !== "shipped" ? <button className="btn-subtle btn-xs" disabled={!!busy} onClick={() => confirm("Discard this plan?") && act("discard")}>Discard</button> : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title={<><span className="font-mono text-dim font-normal">#{plan.no}</span><span className="truncate max-w-[420px]">{plan.title}</span><Chip tone={pipelineTone(plan.pipeline)}>{plan.pipeline.replace("_", " ")}</Chip></>} meta={`${plan.env}${plan.branch ? ` · ${plan.branch}` : ""}`} right={<>{secondary}{primary}</>} />
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="px-6 py-5 flex flex-col gap-4 max-w-[1000px]">
          <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
            {STEPS.map(([id, label], i) => {
              const cur = stepIdx(plan.pipeline), failed = plan.pipeline === "failed";
              const state = failed ? (i === 0 ? "fail" : "todo") : i < cur ? "done" : i === cur ? "cur" : "todo";
              return <span key={id} className="flex items-center gap-2"><span className={cx("flex items-center gap-1.5 whitespace-nowrap", state === "done" ? "text-muted" : state === "cur" ? "text-text font-medium" : state === "fail" ? "text-red-soft font-medium" : "text-dim")}><Dot color={state === "done" ? "green" : state === "cur" ? (plan.pipeline === "shipped" ? "green" : "accent") : state === "fail" ? "red" : "muted"} />{state === "fail" ? "Failed" : label}</span>{i < STEPS.length - 1 && <span className="w-5 h-px bg-border" />}</span>;
            })}
            <span className="text-dim ml-auto">{plan.impact?.summary || "Impact unknown"}{plan.risk !== "low" ? ` · ${plan.risk} risk` : ""}</span>
          </div>

          <Panel title="Changes" right={<span className="text-[12px] text-dim font-normal tabular-nums">{plan.changes.length}</span>} pad={false}>
            <table className="tbl">
              <thead><tr><th>Layer</th><th>Op</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>{plan.changes.map((c, i) => (
                <tr key={i} className={cx("group", c.file && "cursor-pointer hover:bg-surface-2")} onClick={c.file ? () => openFile(c.file!, c.line) : undefined} title={c.file ? `Open ${c.file}${c.line ? `:${c.line}` : ""}` : undefined}>
                  <td><Chip tone={layerTone(c.layer)}>{c.layer}</Chip></td>
                  <td><span className={cx("font-mono text-[12.5px]", c.op === "add" ? "text-green" : c.op === "remove" ? "text-red-soft" : "text-amber")}>{c.op}</span></td>
                  <td className="font-mono">{c.target}</td>
                  <td className="text-muted">{c.detail}{c.file && <div className="font-mono text-[11.5px] text-dim group-hover:text-accent transition">{c.file}{c.line ? `:${c.line}` : ""}</div>}</td>
                </tr>
              ))}</tbody>
            </table>
            {plan.decisions?.suggested?.length ? <div className="px-4 py-3 border-t border-border text-[12.5px] text-muted">Also suggested: {plan.decisions.suggested.join(" · ")}</div> : null}
          </Panel>

          {plan.decisions?.existingRows && (
            <Panel title={`${plan.decisions.existingRows.rows.toLocaleString()} existing rows need a decision`} icon={<span className="text-amber">{Icon.warn({ size: 14 })}</span>} className="border-amber/40">
              <div className="flex flex-col gap-1.5">{plan.decisions.existingRows.options.map((o, i) => <label key={i} className="flex items-center gap-2 text-[13px] text-text-2 cursor-pointer"><input type="radio" checked={plan.decisions.existingRows!.chosen === i} onChange={() => act("decide", { decision: i })} /> {o}</label>)}</div>
            </Panel>
          )}

          {(plan.migrationFwd || plan.migrationRev) && (
            <Panel title="Migration" right={<span className="text-[12px] text-dim font-normal">expand → contract · reverse generated</span>} pad={false}>
              <div className="grid grid-cols-2 divide-x divide-border">
                {([["Forward", plan.migrationFwd], ["Reverse", plan.migrationRev]] as const).map(([l, sql]) => sql ? <div key={l} className="min-w-0"><div className="px-3 h-9 flex items-center justify-between border-b border-border"><span className="eyebrow">{l}</span><CopyButton text={sql} /></div><pre className="p-3 text-[12px] text-text-2 overflow-auto whitespace-pre-wrap max-h-[320px] bg-bg-deep/40">{sql}</pre></div> : null)}
              </div>
            </Panel>
          )}

          <Panel title="Checks" right={plan.checks.length ? <Chip tone={plan.checks.some((c) => c.status === "fail") ? "red" : plan.checks.some((c) => c.status === "warn") ? "amber" : "green"}>{plan.checks.filter((c) => c.status === "pass").length}/{plan.checks.length} passing</Chip> : undefined} pad={false}>
            {plan.checks.map((c, i) => <div key={i} className="flex items-start gap-2.5 px-4 py-2 border-b border-border/60 last:border-b-0 text-[13px]"><Dot color={c.status === "pass" ? "green" : c.status === "fail" ? "red" : c.status === "warn" ? "amber" : "muted"} className="mt-[7px]" /><div className="min-w-0"><div className="font-medium">{c.name}</div><div className="text-[12px] text-muted font-mono break-words">{c.evidence}</div></div></div>)}
            {!plan.checks.length && <div className="px-4 py-3 text-[12.5px] text-dim">No checks yet. Preview the plan to run them.</div>}
          </Panel>

          {plan.decisions?.verify && (
            <Panel title="Verified in repo" pad={false}>
              {plan.decisions.verify.map((v, i) => <div key={i} className="flex items-center gap-2.5 px-4 h-9 border-b border-border/60 last:border-b-0 text-[13px]"><Dot color={v.done ? "green" : "muted"} /><Chip tone={layerTone(v.layer)}>{v.layer}</Chip><span className="font-mono">{v.target}</span></div>)}
            </Panel>
          )}

          <Panel title={plan.pipeline === "shipped" ? "Shipped" : "Hand-off guide"} right={plan.guide && (plan.pipeline === "approved" || plan.pipeline === "shipped") ? <CopyButton text={promptOf(plan.guide)} label="Copy as AI prompt" className="btn-ghost btn-xs" /> : undefined}>
            <p className="text-[12.5px] text-muted leading-relaxed prose">{plan.pipeline === "approved" ? "Make the change in your editor (or paste the prompt into your AI), push, then Verify in repo." : plan.pipeline === "shipped" ? "Arkus found every step of this plan in the code." : "Approve the plan to unlock the step-by-step guide. Arkus never edits your repo in V1."}</p>
            {plan.guide && (plan.pipeline === "approved" || plan.pipeline === "shipped") && <div className="mt-3 max-h-[560px] overflow-auto text-[13px]"><Markdown text={plan.guide} /></div>}
          </Panel>

          <Panel title="Comments" right={<span className="text-[12px] text-dim font-normal">drafted {timeAgo(plan.createdAt)} · updated {timeAgo(plan.updatedAt)} · env {env}</span>}>
            <div className="flex flex-col gap-2">
              {plan.comments.map((c, i) => <div key={i} className="text-[13px] text-text-2"><span className="text-[11.5px] text-dim">{timeAgo(c.at)}</span> · {c.text}</div>)}
              <input className="input input-sm" placeholder="Leave a note and press Enter" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && comment.trim()) { act("comment", { text: comment }); setComment(""); } }} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
