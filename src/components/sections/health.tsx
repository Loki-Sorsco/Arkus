"use client";
// Health screen. Two tabs: Code (deterministic report over the indexed code: what is wrong, why, what to do;
// cached server-side, Refresh recomputes and appends to a score history) and Live API (Arkus probes the
// running app and charts status + latency; see health-live.tsx). ?view=live deep-links the second tab.
import { useCallback, useMemo, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { Chip, EmptyState, Icon, Spinner, Tabs, TONE, useToast, type Tone } from "@/components/ui";
import type { Area, HealthReport, Issue, Severity } from "@/lib/arkus/health";
import { api, cx, useApi } from "@/lib/ui";
import { StatTile } from "./health-charts";
import { HealthLive } from "./health-live";

type HistoryPoint = { at: string; overall: number; areas: Record<string, number> };
type Payload = { report: HealthReport | null; cached: boolean; indexed: boolean; history?: HistoryPoint[] };
type View = "code" | "live";
type Filter = "all" | "security" | "api" | "frontend" | "backend";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "security", label: "Security" }, { id: "api", label: "API" }, { id: "frontend", label: "Frontend" }, { id: "backend", label: "Backend" }];
const AREA_OF: Record<Filter, Area[]> = { all: [], security: ["security"], api: ["api"], frontend: ["frontend"], backend: ["backend", "database"] };
const FILTER_OF: Record<Area, Filter> = { security: "security", api: "api", frontend: "frontend", database: "backend", backend: "backend" };
const AREA_LABEL: Record<Area, string> = { security: "Security", api: "API", frontend: "Frontend", database: "Backend & DB", backend: "Backend" };
const SEV: Record<Severity, { label: string; tone: Tone; heading: string; blurb: string }> = {
  high: { label: "High", tone: "red", heading: "Fix first", blurb: "These can expose data or break the app." },
  medium: { label: "Medium", tone: "amber", heading: "Worth fixing", blurb: "Not urgent, but they cause bugs and slowdowns over time." },
  low: { label: "Low", tone: "blue", heading: "Minor", blurb: "Small clean-ups that make the code easier to work with." },
  info: { label: "Info", tone: "muted", heading: "Good to know", blurb: "Observations; no score impact." },
};
const REST: Severity[] = ["medium", "low", "info"];
const scoreTone = (s: number): Tone => (s >= 85 ? "green" : s >= 60 ? "amber" : "red");
const scoreWord = (s: number) => (s >= 85 ? "good" : s >= 60 ? "needs work" : "serious");
const tileTone = (s: number): "ok" | "warn" | "bad" => (s >= 85 ? "ok" : s >= 60 ? "warn" : "bad");
function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "checked just now" : m < 60 ? `checked ${m} min ago` : m < 1440 ? `checked ${Math.round(m / 60)} h ago` : `checked ${Math.round(m / 1440)} d ago`;
}

export function HealthSection() {
  const { project, graph, graphLoading, openNode, openFile, params, setParams } = useWorkspace();
  const { toast } = useToast();
  const [view, setView] = useState<View>(params.get("view") === "live" ? "live" : "code");
  const [liveMeta, setLiveMeta] = useState<string | undefined>();
  const changeView = (v: View) => { setView(v); setParams({ view: v === "live" ? "live" : undefined }); };
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

  const high = useMemo(() => (report?.issues || []).filter((i) => i.severity === "high"), [report]);
  const rest = useMemo(() => (report?.issues || []).filter((i) => i.severity !== "high"), [report]);
  const visible = useMemo(() => (filter === "all" ? rest : rest.filter((i) => AREA_OF[filter].includes(i.area))), [rest, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, f.id === "all" ? rest.length : rest.filter((i) => AREA_OF[f.id].includes(i.area)).length])) as Record<Filter, number>, [rest]);
  const trend = useMemo(() => {
    // Window = 7 days ending at the newest recorded score (pure: no clock read during render).
    const all = h.data?.history || [];
    const end = all.length ? new Date(all[all.length - 1].at).getTime() : 0;
    const pts = all.filter((p) => new Date(p.at).getTime() >= end - 7 * 86400e3);
    const delta = pts.length >= 2 ? pts[pts.length - 1].overall - pts[0].overall : 0;
    return { values: pts.map((p) => p.overall), delta, n: pts.length };
  }, [h.data]);

  const open = useCallback((i: Issue) => {
    if (i.nodeKey && graph?.nodes.some((n) => n.key === i.nodeKey)) openNode(i.nodeKey);
    else if (i.file) openFile(i.file, i.line);
  }, [graph, openNode, openFile]);
  const canOpen = (i: Issue) => !!(i.nodeKey && graph?.nodes.some((n) => n.key === i.nodeKey)) || !!(i.file && project.rootPath);
  const row = (i: Issue) => <IssueRow key={i.id} issue={i} slug={project.slug} ai={!!project.ai} canOpen={canOpen(i)} onOpen={() => open(i)} />;

  const loading = (graphLoading && !graph) || (h.loading && !report);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Health" meta={view === "code" ? (report ? ago(report.computedAt) : undefined) : liveMeta}
        right={<>
          <Tabs size="sm" value={view} onChange={changeView} items={[{ id: "code", label: "Code", count: report ? report.issues.length : undefined }, { id: "live", label: "Live API" }]} />
          {view === "code" && <button className="btn-subtle btn-xs" disabled={!indexed || refreshing || h.loading} onClick={() => void refresh()} title="Re-run every check (takes a few seconds)">{refreshing ? <Spinner /> : Icon.refresh({ size: 12 })} Refresh</button>}
        </>} />
      <div className="flex-1 min-h-0 overflow-auto">
        {view === "live" ? <HealthLive onMeta={setLiveMeta} />
          : !indexed && !graphLoading ? <EmptyState icon={Icon.activity()} title="Analyse the code first" hint="Health reads the map Arkus builds from your code. Open Settings and run the analysis, then come back here." />
          : loading || (refreshing && !report) ? <div className="h-full flex flex-col items-center justify-center gap-2 text-[12.5px] text-dim"><span className="flex items-center gap-2"><Spinner /> Checking your code</span><span className="text-[12px]">The first run can take about 10 seconds: it also asks npm about vulnerable packages.</span></div>
          : h.error && !report ? <EmptyState title="Could not load the health report" hint={h.error} action={<button className="btn-subtle btn-xs" onClick={() => void h.reload()}>Try again</button>} />
          : report ? (
            <div className={cx("px-6 py-5 max-w-[1100px] flex flex-col gap-6", refreshing && "opacity-60 pointer-events-none")}>
              <p className="prose text-[12.5px] text-muted leading-relaxed">Arkus checked your code for common problems. Nothing here changes your code; each item says what to do.</p>
              <div className="grid grid-cols-5 gap-3">
                <StatTile label="Overall score" value={<>{report.overall}<span className="text-[12px] text-dim font-normal">/100</span></>} tone={tileTone(report.overall)}
                  sub={`${scoreWord(report.overall)} · ${trend.n >= 2 ? (trend.delta === 0 ? "no change" : `${trend.delta > 0 ? "+" : "−"}${Math.abs(trend.delta)} pts`) + " this week" : "no trend yet"}`}
                  spark={trend.values.length >= 2 ? trend.values : undefined} active={filter === "all"} onClick={() => setFilter("all")} />
                {report.areas.map((a) => (
                  <StatTile key={a.area} label={AREA_LABEL[a.area]} value={<>{a.score}<span className="text-[12px] text-dim font-normal">/100</span></>} tone={tileTone(a.score)}
                    sub={`${scoreWord(a.score)} · ${a.issues} issue${a.issues === 1 ? "" : "s"}`} active={filter !== "all" && AREA_OF[filter].includes(a.area)} onClick={() => setFilter(FILTER_OF[a.area])} />
                ))}
              </div>

              <section className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2 h-5"><span className="eyebrow">Fix first</span><span className="text-[12px] text-dim tabular-nums">{high.length}</span><span className="text-[12px] text-dim prose">{SEV.high.blurb}</span></div>
                {high.length ? <div className="card divide-y divide-border">{high.map(row)}</div>
                  : <div className="card px-4 py-3 flex items-center gap-2 text-[12.5px] text-muted prose"><span className="text-green">{Icon.check({ size: 14 })}</span>Nothing serious. Good.</div>}
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-3 h-6"><span className="eyebrow">Everything else</span><Tabs size="sm" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] }))} /></div>
                {!visible.length ? <div className="card px-4 py-3 text-[12.5px] text-muted prose">{filter === "all" ? "No other findings." : `Nothing else to report for ${FILTERS.find((f) => f.id === filter)?.label}.`}</div>
                  : REST.map((sev) => {
                    const rows = visible.filter((i) => i.severity === sev);
                    if (!rows.length) return null;
                    return (
                      <div key={sev} className="flex flex-col gap-1.5">
                        <div className="flex items-baseline gap-2 h-5"><span className="text-[12px] font-semibold text-text-2">{SEV[sev].heading}</span><span className="text-[12px] text-dim tabular-nums">{rows.length}</span><span className="text-[12px] text-dim prose">{SEV[sev].blurb}</span></div>
                        <div className="card divide-y divide-border">{rows.map(row)}</div>
                      </div>
                    );
                  })}
              </section>
              <p className="text-[12px] text-dim prose">Checked {report.stats.endpoints} endpoints, {report.stats.pages} pages, {report.stats.tables} tables and {report.stats.filesScanned} files in {(report.stats.durationMs / 1000).toFixed(1)} s{report.stats.audit ? `; npm audit saw ${report.stats.audit.total} vulnerable package${report.stats.audit.total === 1 ? "" : "s"}` : "; npm audit was skipped (no package-lock.json or npm unavailable)"}.</p>
            </div>
          ) : null}
      </div>
    </div>
  );
}

/** One finding: severity · title · why; click to expand "What to do" (and the AI explanation). Open / Explain on the right. */
function IssueRow({ issue, slug, ai, canOpen, onOpen }: { issue: Issue; slug: string; ai: boolean; canOpen: boolean; onOpen: () => void }) {
  const [openRow, setOpenRow] = useState(false);
  const [state, setState] = useState<{ loading: boolean; text: string | null; tried: boolean }>({ loading: false, text: null, tried: false });
  const explain = async () => {
    setOpenRow(true);
    setState({ loading: true, text: null, tried: true });
    try { const r = await api<{ explanation: string | null }>(`/api/projects/${slug}/health`, { json: { issueId: issue.id } }); setState({ loading: false, text: r.explanation, tried: true }); }
    catch { setState({ loading: false, text: null, tried: true }); }
  };
  const s = SEV[issue.severity];
  return (
    <div className={cx("px-4 py-2.5 flex gap-3 items-start cursor-pointer transition", openRow ? "bg-surface-2" : "hover:bg-surface-2")} onClick={() => setOpenRow((o) => !o)}>
      <span className={cx("type-pill mt-[3px] w-[58px] justify-center flex-none", TONE[s.tone])}>{s.label}</span>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12.5px] font-semibold text-text truncate">{issue.title}</span>
          {issue.count != null && issue.count > 1 && <Chip tone="muted">{issue.count}</Chip>}
          <Chip tone="muted" className="font-normal flex-none">{AREA_LABEL[issue.area]}</Chip>
          {issue.file && <span className="font-mono text-[11.5px] text-dim truncate">{issue.file}{issue.line ? `:${issue.line}` : ""}</span>}
        </div>
        <p className={cx("prose text-[12.5px] text-muted leading-relaxed", !openRow && "truncate")}>{issue.why}</p>
        {openRow && (
          <div className="flex flex-col gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
            <div><span className="eyebrow">What to do</span><p className="prose text-[12.5px] text-text-2 leading-relaxed mt-0.5">{issue.fix}</p></div>
            {state.tried && <div className="border-l-2 border-accent/40 pl-3 prose text-[12.5px] text-text-2 leading-relaxed flex items-start gap-2">{state.loading ? <><Spinner /> Asking AI</> : (state.text ?? "AI could not explain this one right now. The text above still tells you what to do.")}</div>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 text-[12px] flex-none mt-[2px]" onClick={(e) => e.stopPropagation()}>
        {canOpen && <button className="link" onClick={onOpen}>Open</button>}
        {ai && <button className="link disabled:opacity-50" disabled={state.loading} onClick={() => void explain()}>Explain</button>}
        <span className={cx("text-dim transition", openRow && "rotate-90")}>{Icon.chevron({ size: 12 })}</span>
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
