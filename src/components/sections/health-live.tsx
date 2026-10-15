"use client";
// Live API tab of the Health screen: Arkus sends GET requests to the user's running app (same base URL and
// auth as the Test tab), keeps status + latency per endpoint, and charts it so a failing API is visible at
// a glance. A check runs in batches from the browser so the button can show real progress ("12 / 48").
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { EmptyState, Icon, MethodBadge, Spinner, Tabs, Toggle, useToast } from "@/components/ui";
import type { EndpointSummary, ProbeState, ProbeTotals, SeriesPoint } from "@/lib/arkus/probe";
import type { HttpAuth, HttpEnv } from "@/lib/arkus/http";
import { api, cx, timeAgo, useApi } from "@/lib/ui";
import { fmtMs, fmtPct, LatencyChart, Sparkline, StatTile, StateLabel, type Tone } from "./health-charts";

type Payload = { baseUrl: string; window: string; endpoints: EndpointSummary[]; series: Record<string, SeriesPoint[]>; totals: ProbeTotals; uptimes: number[]; candidates: number; indexed: boolean };
type EnvView = Omit<HttpEnv, "auth"> & { auth: HttpAuth & { hasToken?: boolean } };
type Win = "24h" | "7d";
const STATE: Record<ProbeState, { label: string; tone: Tone }> = { ok: { label: "ok", tone: "ok" }, slow: { label: "slow", tone: "warn" }, failing: { label: "failing", tone: "bad" }, unreachable: { label: "unreachable", tone: "bad" } };
const BATCH = 8;
const AUTO_MS = 60_000;

export function HealthLive({ onMeta }: { onMeta?: (s: string | undefined) => void }) {
  const { project, env, graph, openNode } = useWorkspace();
  const { toast } = useToast();
  const [win, setWin] = useState<Win>("24h");
  const url = `/api/projects/${project.slug}/probe?env=${env}&window=${win}`;
  const live = useApi<Payload>(url);
  const data = live.data;
  const setData = live.setData;
  const [envInfo, setEnvInfo] = useState<EnvView | null>(null);
  const [base, setBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [auto, setAuto] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    let on = true;
    api<{ value: EnvView }>(`/api/projects/${project.slug}/http/env?env=${env}`).then((r) => { if (on) { setEnvInfo(r.value); setBase(r.value.baseUrl); } }).catch(() => undefined);
    return () => { on = false; };
  }, [project.slug, env]);
  useEffect(() => { onMeta?.(data?.totals.lastAt ? `last check ${timeAgo(data.totals.lastAt)}` : undefined); }, [data, onMeta]);

  const saveBase = useCallback(async (value?: string) => {
    const next = (value ?? base).trim().replace(/\/+$/, "");
    if (!envInfo || next === envInfo.baseUrl || saving) return;
    setSaving(true);
    try { const r = await api<{ value: EnvView }>(`/api/projects/${project.slug}/http/env`, { method: "PUT", json: { env, value: { ...envInfo, baseUrl: next } } }); setEnvInfo(r.value); setBase(r.value.baseUrl); setData((d) => (d ? { ...d, baseUrl: r.value.baseUrl } : d)); }
    catch (e) { toast({ title: "Could not save the base URL", detail: (e as Error).message, kind: "error" }); }
    finally { setSaving(false); }
  }, [base, envInfo, saving, project.slug, env, toast, setData]);

  const keys = useMemo(() => (graph?.nodes || []).filter((n) => n.type === "endpoint" && ["GET", "HEAD"].includes(String(n.attrs?.method || "GET").toUpperCase())).map((n) => n.key), [graph]);
  const baseUrl = envInfo?.baseUrl || data?.baseUrl || "";

  const run = useCallback(async () => {
    if (running.current || !keys.length || !baseUrl) return;
    running.current = true;
    setProgress({ done: 0, total: keys.length });
    try {
      let last: Payload | null = null;
      for (let i = 0; i < keys.length; i += BATCH) {
        last = await api<Payload>(`/api/projects/${project.slug}/probe`, { json: { env, keys: keys.slice(i, i + BATCH), window: win } });
        setProgress({ done: Math.min(keys.length, i + BATCH), total: keys.length });
      }
      if (last) setData(last);
    } catch (e) { toast({ title: "Check failed", detail: (e as Error).message, kind: "error" }); }
    finally { running.current = false; setProgress(null); }
  }, [keys, baseUrl, project.slug, env, win, setData, toast]);

  useEffect(() => { if (!auto) return; const t = setInterval(() => void run(), AUTO_MS); return () => clearInterval(t); }, [auto, run]);

  const eps = useMemo(() => data?.endpoints || [], [data]);
  const current = useMemo(() => eps.find((e) => e.key === selected) || eps[0] || null, [eps, selected]);
  const t = data?.totals;
  const allDown = !!t && t.checked > 0 && t.unreachable === t.checked;
  const firstError = eps.find((e) => e.lastError)?.lastError;
  let basePath = "";
  try { basePath = baseUrl ? new URL(baseUrl).pathname.replace(/\/+$/, "") : ""; } catch { basePath = ""; }
  const all404 = eps.length > 0 && eps.every((e) => e.lastStatus === 404);
  const indexed = !!graph?.snapshotId;

  const baseInput = (
    <div className="flex items-center gap-1.5 min-w-0">
      <input className="input input-sm h-7 font-mono text-[12px] w-[280px]" value={base} placeholder="http://localhost:3000" spellCheck={false} onChange={(e) => setBase(e.target.value)} onBlur={() => void saveBase()} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      {saving && <Spinner />}
    </div>
  );

  if (!indexed) return <EmptyState icon={Icon.activity()} title="Analyse the code first" hint="Live API checks the endpoints Arkus found in your code. Open Settings and run the analysis, then come back here." />;
  if (envInfo && !baseUrl) return (
    <EmptyState icon={Icon.api()} title="Tell Arkus where your app runs" hint={<span className="prose">Enter the base URL of your running app for the {env} environment. Arkus sends GET requests to your running app and keeps the results. Nothing is changed.</span>}
      action={<div className="flex items-center gap-2">{baseInput}<button className="btn-primary btn-sm" disabled={!base.trim()} onClick={() => void saveBase()}>Save</button></div>} />
  );

  return (
    <div className="px-6 py-5 max-w-[1100px] flex flex-col gap-5">
      <p className="prose text-[12.5px] text-muted leading-relaxed">Arkus sends GET requests to your running app and keeps the results. Nothing is changed.</p>
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[12px] text-dim whitespace-nowrap">Base URL · {env}</span>
        {baseInput}
        <button className="btn-primary btn-sm" disabled={!!progress || !keys.length || !baseUrl} onClick={() => void run()} title={`Send a GET to each of the ${keys.length} GET endpoints`}>
          {progress ? <><Spinner /> <span className="tabular-nums">{progress.done} / {progress.total}</span></> : <>{Icon.play({ size: 12 })} Run check</>}
        </button>
        <Toggle checked={auto} onChange={setAuto} label={<span className="text-[12.5px]">Auto-check every 60 s</span>} />
        <div className="flex-1" />
        <Tabs size="sm" value={win} onChange={setWin} items={[{ id: "24h", label: "24h" }, { id: "7d", label: "7d" }]} />
      </div>
        {basePath && basePath !== "/" && (
          <div className="mb-3 rounded-[7px] border border-amber/40 bg-amber/10 px-3 py-2 text-[12.5px] text-amber flex items-center gap-3 prose">
            <span className="flex-1">The base URL includes a path (<span className="font-mono">{basePath}</span>). Arkus adds each API's own path after it, so use the address where the app starts.</span>
            <button className="btn-ghost btn-xs whitespace-nowrap" onClick={() => { try { const u = new URL(baseUrl); void saveBase(u.origin); } catch { /* ignore */ } }}>Use {(() => { try { return new URL(baseUrl).origin; } catch { return "origin"; } })()}</button>
          </div>
        )}
        {all404 && (
          <div className="mb-3 rounded-[7px] border border-border bg-surface-2 px-3 py-2 text-[12.5px] text-text-2 prose">Every endpoint answered <span className="font-mono">404 Not Found</span> at this address, which means the server exists but these paths are not on it. Check the base URL points at this app, not another one, and that it is the root address.</div>
        )}

      {live.loading && !data ? <div className="flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> Loading</div>
        : live.error && !data ? <EmptyState compact title="Could not load the live results" hint={live.error} action={<button className="btn-subtle btn-xs" onClick={() => void live.reload()}>Try again</button>} />
        : !t || !eps.length ? <EmptyState compact icon={Icon.play()} title="No checks yet" hint={<span className="prose">Run a check to send a GET to each of the {keys.length} endpoints at <span className="font-mono">{baseUrl}</span>.</span>} />
        : (
          <>
            {allDown && (
              <div className="card px-4 py-3 flex items-start gap-3 border-red/40">
                <span className="text-red-soft mt-px">{Icon.warn({ size: 16 })}</span>
                <div className="min-w-0"><div className="text-[12.5px] font-semibold text-text">Could not reach <span className="font-mono">{baseUrl}</span>. Is the app running?</div>{firstError && <div className="text-[12px] text-muted mt-0.5 prose truncate" title={firstError}>{firstError}</div>}</div>
              </div>
            )}
            <div className="grid grid-cols-4 gap-3">
              <StatTile label="Uptime" value={fmtPct(t.uptime)} tone={t.uptime >= 99 ? "ok" : t.uptime >= 90 ? "warn" : "bad"} sub={t.uptime >= 99 ? "ok · all answered" : t.uptime >= 90 ? "warning · some failed" : "serious · most failed"} spark={data!.uptimes} />
              <StatTile label="Checked" value={t.checked} sub={`of ${data!.candidates} GET endpoints · ${t.runs} run${t.runs === 1 ? "" : "s"}`} />
              <StatTile label="Failing" value={t.failing + t.unreachable} tone={t.failing + t.unreachable > 0 ? "bad" : "ok"} sub={t.failing + t.unreachable > 0 ? `serious · ${t.failing} failing, ${t.unreachable} unreachable` : "ok · none failing"} />
              <StatTile label="p95 latency" value={fmtMs(t.p95)} tone={t.p95 > 1500 ? "warn" : "neutral"} sub={t.p95 > 1500 ? `slow · p50 ${fmtMs(t.p50)}` : `p50 ${fmtMs(t.p50)}`} />
            </div>
            {current && (
              <div className="card px-4 py-3">
                <LatencyChart points={data!.series[current.key] || []} title={<span className="flex items-center gap-2 min-w-0"><MethodBadge method={current.method} /><span className="font-mono text-[12.5px] truncate">{current.path}</span><StateLabel tone={STATE[current.state].tone} className="text-[11.5px] font-normal">{stateText(current)}</StateLabel></span>} />
              </div>
            )}
            <div className="card overflow-hidden">
              <table className="tbl hover">
                <thead><tr><th className="w-[70px]">Method</th><th>Path</th><th className="w-[120px]">State</th><th className="w-[70px] text-right">Last</th><th className="w-[80px] text-right">ms</th><th className="w-[80px] text-right">p95</th><th className="w-[80px] text-right">Uptime</th><th className="w-[110px]">Trend</th><th className="w-[70px] text-right">Failed</th><th className="w-[60px]" /></tr></thead>
                <tbody>
                  {eps.map((e) => (
                    <tr key={e.key} onClick={() => setSelected(e.key)} className={cx("cursor-pointer", current?.key === e.key && "bg-surface-2")}>
                      <td><MethodBadge method={e.method} /></td>
                      <td className="max-w-[300px]"><div className="font-mono text-[12px] truncate" title={e.path}>{e.path}</div><div className="text-[10.5px] text-dim truncate" title={e.lastUrl}>{e.lastUrl.replace(/^https?:\/\//, "")}</div>{e.lastError && e.state !== "ok" && <div className="text-[10.5px] text-muted truncate prose" title={e.lastError}>{e.lastError}</div>}</td>
                      <td className="text-[12px]"><StateLabel tone={STATE[e.state].tone}>{STATE[e.state].label}</StateLabel></td>
                      <td className="text-right tabular-nums text-[12px] text-text-2">{e.lastStatus || "—"}</td>
                      <td className="text-right tabular-nums text-[12px] text-text-2">{e.lastStatus ? fmtMs(e.lastMs) : "—"}</td>
                      <td className="text-right tabular-nums text-[12px] text-text-2">{e.p95 ? fmtMs(e.p95) : "—"}</td>
                      <td className="text-right tabular-nums text-[12px] text-text-2">{fmtPct(e.uptime)}</td>
                      <td><Sparkline values={e.trend} width={96} height={20} zeroAsGap /></td>
                      <td className={cx("text-right tabular-nums text-[12px]", e.failures ? "text-red-soft" : "text-text-2")}>{e.failures}</td>
                      <td className="text-right"><button className="link text-[12px]" onClick={(ev) => { ev.stopPropagation(); openNode(e.key); }}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-dim prose">{t.checked} endpoint{t.checked === 1 ? "" : "s"} over the last {win === "24h" ? "24 hours" : "7 days"}; {t.runs} run{t.runs === 1 ? "" : "s"}. Arkus keeps the last 2 000 probes per environment and never stores response bodies.</p>
          </>
        )}
    </div>
  );
}

function stateText(e: EndpointSummary) {
  if (e.state === "unreachable") return "unreachable";
  if (e.state === "failing") return `failed ${e.lastStatus}`;
  if (e.state === "slow") return `slow · p95 ${fmtMs(e.p95)}`;
  return `ok ${e.lastStatus} · ${fmtMs(e.lastMs)}`;
}
