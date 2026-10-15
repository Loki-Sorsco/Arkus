"use client";
// Health screen: one report that tells a developer how healthy the frontend, API, backend/database
// and security are, what is wrong, why it matters and what to do. Cached server-side; Refresh recomputes.
import { useCallback, useMemo, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { Chip, EmptyState, Icon, Spinner, Tabs, TONE, useToast, type Tone } from "@/components/ui";
import type { Area, HealthReport, Issue, Severity } from "@/lib/arkus/health";
import { api, cx, useApi } from "@/lib/ui";

type Payload = { report: HealthReport | null; cached: boolean; indexed: boolean };
type Filter = "all" | "security" | "api" | "frontend" | "backend";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "security", label: "Security" }, { id: "api", label: "API" }, { id: "frontend", label: "Frontend" }, { id: "backend", label: "Backend" }];
const AREA_OF: Record<Filter, Area[]> = { all: [], security: ["security"], api: ["api"], frontend: ["frontend"], backend: ["backend", "database"] };
const AREA_LABEL: Record<Area, string> = { security: "Security", api: "API", frontend: "Frontend", database: "Backend & DB", backend: "Backend" };
const SEV: Record<Severity, { label: string; tone: Tone; heading: string; blurb: string }> = {
  high: { label: "High", tone: "red", heading: "Fix first", blurb: "These can expose data or break the app." },
  medium: { label: "Medium", tone: "amber", heading: "Worth fixing", blurb: "Not urgent, but they cause bugs and slowdowns over time." },
  low: { label: "Low", tone: "blue", heading: "Minor", blurb: "Small clean-ups that make the code easier to work with." },
  info: { label: "Info", tone: "muted", heading: "Good to know", blurb: "Observations; no score impact." },
};
const ORDER: Severity[] = ["high", "medium", "low", "info"];
const scoreTone = (s: number): Tone => (s >= 85 ? "green" : s >= 60 ? "amber" : "red");
const scoreText = (s: number) => (s >= 85 ? "text-green" : s >= 60 ? "text-amber" : "text-red-soft");
function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "checked just now" : m < 60 ? `checked ${m} min ago` : m < 1440 ? `checked ${Math.round(m / 60)} h ago` : `checked ${Math.round(m / 1440)} d ago`;
}

export function HealthSection() {
  const { project, graph, graphLoading, openNode, openFile } = useWorkspace();
  const { toast } = useToast();
  const indexed = !!graph?.snapshotId;
  const url = indexed ? `/api/projects/${project.slug}/health` : null;
  const h = useApi<Payload>(url);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const report = h.data?.report ?? null;
  const setData = h.setData;

  const refresh = useCallback(async () => {
    if (!url) return;
    setRefreshing(true);
    try { setData(await api<Payload>(`${url}?refresh=1`)); }
    catch (e) { toast({ title: "Could not refresh the health report", detail: (e as Error).message, kind: "error" }); }
    finally { setRefreshing(false); }
  }, [url, setData, toast]);

  const visible = useMemo(() => {
    const all = report?.issues || [];
    return filter === "all" ? all : all.filter((i) => AREA_OF[filter].includes(i.area));
  }, [report, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, f.id === "all" ? (report?.issues.length || 0) : (report?.issues.filter((i) => AREA_OF[f.id].includes(i.area)).length || 0)])) as Record<Filter, number>, [report]);

  const open = useCallback((i: Issue) => {
    if (i.nodeKey && graph?.nodes.some((n) => n.key === i.nodeKey)) openNode(i.nodeKey);
    else if (i.file) openFile(i.file, i.line);
  }, [graph, openNode, openFile]);

  const loading = (graphLoading && !graph) || (h.loading && !report);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Health" meta={report ? ago(report.computedAt) : undefined}
        right={<>
          <Tabs size="sm" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ id: f.id, label: f.label, count: report ? counts[f.id] : undefined }))} />
          <button className="btn-subtle btn-xs" disabled={!indexed || refreshing || h.loading} onClick={() => void refresh()} title="Re-run every check (takes a few seconds)">{refreshing ? <Spinner /> : Icon.refresh({ size: 12 })} Refresh</button>
        </>} />
      <div className="flex-1 min-h-0 overflow-auto">
        {!indexed && !graphLoading ? <EmptyState icon={Icon.activity()} title="Analyse the code first" hint="Health reads the map Arkus builds from your code. Open Settings and run the analysis, then come back here." />
          : loading || (refreshing && !report) ? <div className="h-full flex flex-col items-center justify-center gap-2 text-[12.5px] text-dim"><span className="flex items-center gap-2"><Spinner /> Checking your code</span><span className="text-[12px]">The first run can take about 10 seconds: it also asks npm about vulnerable packages.</span></div>
          : h.error && !report ? <EmptyState title="Could not load the health report" hint={h.error} action={<button className="btn-subtle btn-xs" onClick={() => void h.reload()}>Try again</button>} />
          : report ? (
            <div className={cx("px-6 py-5 max-w-[1100px] flex flex-col gap-5", refreshing && "opacity-60 pointer-events-none")}>
              <p className="prose text-[12.5px] text-muted leading-relaxed">Arkus checked your code for common problems. Nothing here changes your code; each item says what to do.</p>
              <div className="grid grid-cols-5 gap-3">
                <ScoreBox label="Overall" score={report.overall} summary={`${report.stats.bySeverity.high} serious, ${report.stats.bySeverity.medium} medium, ${report.stats.bySeverity.low} minor issue${report.stats.bySeverity.low === 1 ? "" : "s"} across ${report.stats.filesScanned} files.`} big />
                {report.areas.map((a) => <ScoreBox key={a.area} label={AREA_LABEL[a.area]} score={a.score} summary={a.summary} onClick={() => setFilter(a.area === "database" || a.area === "backend" ? "backend" : a.area)} active={filter !== "all" && AREA_OF[filter].includes(a.area)} />)}
              </div>
              {!visible.length ? <EmptyState compact icon={Icon.check()} title={filter === "all" ? "No problems found" : `Nothing to report for ${FILTERS.find((f) => f.id === filter)?.label}`} hint="Keep the index fresh and refresh after big changes." />
                : ORDER.map((sev) => {
                  const rows = visible.filter((i) => i.severity === sev);
                  if (!rows.length) return null;
                  return (
                    <section key={sev} className="flex flex-col gap-2">
                      <div className="flex items-baseline gap-2 h-5"><span className="eyebrow">{SEV[sev].heading}</span><span className="text-[12px] text-dim tabular-nums">{rows.length}</span><span className="text-[12px] text-dim prose">{SEV[sev].blurb}</span></div>
                      {rows.map((i) => <IssueRow key={i.id} issue={i} slug={project.slug} ai={!!project.ai} canOpen={!!(i.nodeKey && graph?.nodes.some((n) => n.key === i.nodeKey)) || !!(i.file && project.rootPath)} onOpen={() => open(i)} />)}
                    </section>
                  );
                })}
              <p className="text-[12px] text-dim">Checked {report.stats.endpoints} endpoints, {report.stats.pages} pages, {report.stats.tables} tables and {report.stats.filesScanned} files in {(report.stats.durationMs / 1000).toFixed(1)} s{report.stats.audit ? `; npm audit saw ${report.stats.audit.total} vulnerable package${report.stats.audit.total === 1 ? "" : "s"}` : "; npm audit was skipped (no package-lock.json or npm unavailable)"}.</p>
            </div>
          ) : null}
      </div>
    </div>
  );
}

function ScoreBox({ label, score, summary, big, onClick, active }: { label: string; score: number; summary: string; big?: boolean; onClick?: () => void; active?: boolean }) {
  return (
    <div onClick={onClick} className={cx("stat-box !px-3 !py-2.5 gap-1.5", onClick && "cursor-pointer hover:border-border-strong transition", active && "border-border-strong bg-surface-2")}>
      <div className="flex items-center gap-2.5">
        <Ring score={score} size={big ? 44 : 36} />
        <div className="min-w-0"><div className="k">{label}</div><div className={cx("v", big ? "!text-[18px]" : "!text-[15px]", scoreText(score))}>{score}<span className="text-dim font-normal text-[10px]">/100</span></div></div>
      </div>
      <div className="prose text-[11.5px] text-muted leading-snug">{summary}</div>
    </div>
  );
}

function Ring({ score, size }: { score: number; size: number }) {
  const r = (size - 4) / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx("flex-none -rotate-90", scoreText(score))} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={3} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeDasharray={`${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`} />
    </svg>
  );
}

function IssueRow({ issue, slug, ai, canOpen, onOpen }: { issue: Issue; slug: string; ai: boolean; canOpen: boolean; onOpen: () => void }) {
  const [state, setState] = useState<{ loading: boolean; text: string | null; tried: boolean }>({ loading: false, text: null, tried: false });
  const explain = async () => {
    setState({ loading: true, text: null, tried: true });
    try { const r = await api<{ explanation: string | null }>(`/api/projects/${slug}/health`, { json: { issueId: issue.id } }); setState({ loading: false, text: r.explanation, tried: true }); }
    catch { setState({ loading: false, text: null, tried: true }); }
  };
  const s = SEV[issue.severity];
  return (
    <div className="card px-4 py-3 flex gap-3 items-start">
      <span className={cx("type-pill mt-[3px] w-[58px] justify-center", TONE[s.tone])}>{s.label}</span>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-[12.5px] font-semibold text-text">{issue.title}</span>
          {issue.count != null && issue.count > 1 && <Chip tone="muted">{issue.count}</Chip>}
          <Chip tone="muted" className="font-normal">{AREA_LABEL[issue.area]}</Chip>
          {issue.file && <span className="font-mono text-[11.5px] text-dim truncate">{issue.file}{issue.line ? `:${issue.line}` : ""}</span>}
        </div>
        <p className="prose text-[12.5px] text-muted leading-relaxed">{issue.why}</p>
        <div><span className="eyebrow">What to do</span><p className="prose text-[12.5px] text-text-2 leading-relaxed mt-0.5">{issue.fix}</p></div>
        <div className="flex items-center gap-3 text-[12px] mt-0.5">
          {canOpen && <button className="text-accent hover:text-accent-hover cursor-pointer" onClick={onOpen}>Open</button>}
          {ai && <button className="text-accent hover:text-accent-hover cursor-pointer disabled:opacity-50 flex items-center gap-1" disabled={state.loading} onClick={() => void explain()}>{state.loading && <Spinner />}Explain</button>}
        </div>
        {state.tried && !state.loading && <div className="border-l-2 border-accent/40 pl-3 prose text-[12.5px] text-text-2 leading-relaxed">{state.text ?? "AI could not explain this one right now. The text above still tells you what to do."}</div>}
      </div>
    </div>
  );
}

/** Small chip for the title bar: "Health 82". Uses the cached report; renders nothing until there is one. */
export function HealthBadge() {
  const { project, graph, go } = useWorkspace();
  const h = useApi<Payload>(graph?.snapshotId ? `/api/projects/${project.slug}/health` : null);
  const score = h.data?.report?.overall;
  if (score == null) return null;
  return <Chip tone={scoreTone(score)} onClick={() => go("health")} title="Open the health report">Health {score}</Chip>;
}
