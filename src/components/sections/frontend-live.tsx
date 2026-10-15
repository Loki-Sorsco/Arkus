"use client";
// Live view: the real page in an iframe (PagePreview) under a toolbar that, on the user's own machine,
// can start and stop the app's dev server through /api/projects/:id/run. Cloud mode only asks for the
// URL where the app runs. The first localhost URL the app prints becomes the Dev base URL.
import { useCallback, useEffect, useRef, useState } from "react";
import { PagePreview } from "@/components/screens/page-preview";
import { useWorkspace } from "@/components/shell/workspace";
import { Dot, Icon, Spinner } from "@/components/ui";
import { useMe } from "@/lib/me";
import { api, cx } from "@/lib/ui";

type Status = { running: boolean; pid?: number; url?: string; command?: string; startedAt?: string; exitCode?: number | null; log: string[] };

export function FrontendLive({ path }: { path: string }) {
  const { project, env } = useWorkspace();
  const me = useMe();
  const cloud = !!me?.cloud;
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [base, setBase] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runUrl = `/api/projects/${project.slug}/run`;

  const loadBase = useCallback(async () => { try { const r = await api<{ value: { baseUrl?: string } }>(`/api/projects/${project.slug}/http/env?env=${env}`); setBase(r.value.baseUrl || ""); } catch { setBase(""); } }, [project.slug, env]);
  const refresh = useCallback(async () => { try { const s = await api<Status>(runUrl); setStatus(s); return s; } catch (e) { setError((e as Error).message); return null; } }, [runUrl]);
  useEffect(() => { void loadBase(); }, [loadBase]);
  useEffect(() => { if (!cloud && me) void refresh(); }, [cloud, me, refresh]);

  // While the app is starting, poll every 2 s until it prints its URL; then re-read the base URL once.
  const waiting = !!status?.running && !status.url;
  useEffect(() => {
    if (!waiting) return;
    timer.current = setTimeout(async () => { const s = await refresh(); if (s?.url) { await loadBase(); setShowLog(false); } }, 2000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [waiting, status, refresh, loadBase]);

  const start = async () => { setBusy("start"); setError(null); setShowLog(true); try { setStatus(await api<Status>(runUrl, { method: "POST" })); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const stop = async () => { setBusy("stop"); setError(null); try { setStatus(await api<Status>(runUrl, { method: "DELETE" })); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };

  const running = !!status?.running;
  const exited = status && !status.running && status.exitCode != null;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-none flex items-center gap-2 px-3 h-9 border-b border-border bg-surface text-[12px]">
        {cloud ? (
          <span className="text-muted prose">Enter where the app runs{base ? <>: <span className="font-mono text-text-2">{base}</span></> : "."}</span>
        ) : (
          <>
            {running ? <Dot color={status?.url ? "green" : "amber"} pulse={!status?.url} /> : <Dot color="muted" />}
            <span className="text-muted prose truncate min-w-0">
              {running && status?.url ? <>App running at <span className="font-mono text-text-2">{status.url}</span></>
                : running ? <>Starting <span className="font-mono text-text-2">{status?.command}</span>…</>
                : exited ? <>The app stopped{status?.exitCode ? <> with code <span className="font-mono">{status.exitCode}</span></> : ""}. Check the log.</>
                : base ? <>Showing <span className="font-mono text-text-2">{base}</span> on <span className="capitalize">{env}</span>.</> : "The app is not running. Start it here or enter its address below."}
            </span>
            <span className="flex-1" />
            {(status?.log.length ?? 0) > 0 && <button className="btn-subtle btn-xs" onClick={() => setShowLog((o) => !o)}>{showLog ? "Hide log" : "Show log"}</button>}
            {status?.url && <a className="btn-subtle btn-xs" href={status.url} target="_blank" rel="noreferrer">{Icon.external({ size: 12 })} Open in new tab</a>}
            {running
              ? <button className="btn-ghost btn-xs dev-only" disabled={busy === "stop"} onClick={() => void stop()}>{busy === "stop" ? <Spinner /> : Icon.close({ size: 12 })} Stop</button>
              : <button className="btn-primary btn-xs dev-only" disabled={busy === "start" || !project.rootPath} title={project.rootPath ? "Start the app's dev server from its folder" : "This project has no local folder"} onClick={() => void start()}>{busy === "start" ? <Spinner /> : Icon.play({ size: 12 })} Run app</button>}
          </>
        )}
      </div>
      {error && <div className="flex-none px-3 py-1.5 text-[12px] text-red-soft border-b border-border bg-surface-2 prose">{error}</div>}
      {showLog && status && status.log.length > 0 && (
        <pre className={cx("flex-none max-h-[180px] overflow-auto px-3 py-2 border-b border-border bg-bg-deep font-mono text-[11px] leading-[1.5] text-text-2 whitespace-pre-wrap break-all")}>{status.log.slice(-60).join("\n")}</pre>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <div className="max-w-[1100px] mx-auto">
          <PagePreview key={`${env}:${base}`} path={path} />
        </div>
      </div>
    </div>
  );
}
