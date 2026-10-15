"use client";
// Test view of the APIs section: a lean request runner for one endpoint. Method is fixed by the endpoint,
// the URL starts as {{baseUrl}}/path, Send goes through POST /http/send (server side, no CORS; non-GET
// sends pass the typed gate). Drafts live in a module-level map so switching endpoints keeps your edits.
import { useCallback, useEffect, useState } from "react";
import { ResizeHandle, useResizable } from "@/components/shell/resize";
import { useWorkspace } from "@/components/shell/workspace";
import { draftFromEndpoint, ENV_LABEL, EnvironmentModal, RequestEditor, type Draft, type EnvView } from "@/components/tabs/request-editor";
import { ResponseView, type SendResponse } from "@/components/tabs/response-view";
import { useViewer } from "@/lib/me";
import { Icon, MethodBadge, Spinner, useToast } from "@/components/ui";
import type { GNode } from "@/lib/arkus/types";
import { api, cx } from "@/lib/ui";

type Entry = { draft: Draft; res: SendResponse | null };
/** Per-endpoint drafts + last response, kept for the life of the page (keyed by endpoint graph key). */
const drafts = new Map<string, Entry>();
const entryFor = (ep: GNode): Entry => { let e = drafts.get(ep.key); if (!e) { e = { draft: draftFromEndpoint(ep), res: null }; drafts.set(ep.key, e); } return e; };

export function ApiTest({ ep }: { ep: GNode }) {
  const viewer = useViewer();
  const { project, env, gate } = useWorkspace();
  const { toast } = useToast();
  const [entry, setEntry] = useState<Entry>(() => entryFor(ep));
  const [busy, setBusy] = useState(false);
  const [envInfo, setEnvInfo] = useState<EnvView | null>(null);
  const [base, setBase] = useState("");
  const [savingBase, setSavingBase] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { size, handle } = useResizable("apis-test-editor", 260, { min: 96, max: 900, axis: "y" });

  // Switch drafts with the endpoint (and remember the one we leave).
  useEffect(() => { setEntry(entryFor(ep)); setBusy(false); }, [ep]);
  const update = useCallback((fn: (e: Entry) => Entry) => setEntry((e) => { const next = fn(e); drafts.set(ep.key, next); return next; }), [ep.key]);
  const patch = useCallback((p: Partial<Draft>) => update((e) => ({ ...e, draft: { ...e.draft, ...p } })), [update]);

  // Environment (base URL · headers · auth) for the current env.
  useEffect(() => {
    let live = true;
    api<{ value: EnvView }>(`/api/projects/${project.slug}/http/env?env=${env}`).then((r) => { if (live) { setEnvInfo(r.value); setBase(r.value.baseUrl); } }).catch(() => undefined);
    return () => { live = false; };
  }, [project.slug, env]);
  const saveBase = useCallback(async () => {
    const next = base.trim();
    if (!envInfo || next === envInfo.baseUrl || savingBase) return;
    setSavingBase(true);
    try { const r = await api<{ value: EnvView }>(`/api/projects/${project.slug}/http/env`, { method: "PUT", json: { env, value: { ...envInfo, baseUrl: next } } }); setEnvInfo(r.value); setBase(r.value.baseUrl); }
    catch (e) { toast({ title: "Could not save the base URL", detail: (e as Error).message, kind: "error" }); }
    finally { setSavingBase(false); }
  }, [base, envInfo, savingBase, project.slug, env, toast]);

  const send = useCallback(() => {
    if (busy) return;
    const draft = entry.draft;
    const run = async () => {
      setBusy(true);
      try { const res = await api<SendResponse>(`/api/projects/${project.slug}/http/send`, { json: { env, request: draft } }); update((e) => ({ ...e, res })); }
      catch (e) { toast({ title: "Send failed", detail: (e as Error).message, kind: "error" }); }
      finally { setBusy(false); }
    };
    if (draft.method === "GET") void run(); else gate(run);
  }, [busy, entry.draft, env, project.slug, gate, toast, update]);

  const hasAuth = !!envInfo && envInfo.auth.type !== "none";
  return (
    <div className="flex-1 min-h-0 flex flex-col text-[12.5px]" onKeyDownCapture={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); } }}>
      <div className="h-10 flex-none flex items-center gap-2 px-3 border-b border-border bg-surface">
        <MethodBadge method={entry.draft.method} className="h-7 flex-none" />
        <input className="input input-sm h-7 font-mono text-[12px] flex-1 min-w-[160px]" value={entry.draft.url} placeholder="{{baseUrl}}/path" spellCheck={false} onChange={(e) => patch({ url: e.target.value })} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="btn-primary btn-xs h-7 px-3" disabled={busy || (viewer && entry.draft.method !== "GET")} onClick={send} title={viewer && entry.draft.method !== "GET" ? "View-only mode can send GET requests only" : "Send (Ctrl Enter)"}>{busy ? <Spinner /> : Icon.play({ size: 11 })} Send</button>
        <span className="w-px h-5 bg-border mx-1 flex-none" />
        <label className="flex items-center gap-1.5 flex-none text-[11.5px] text-dim whitespace-nowrap" title={`Base URL for {{baseUrl}} in the ${ENV_LABEL[env]} environment`}>
          <span>{ENV_LABEL[env]} base</span>
          <span className="relative">
            <input className={cx("input input-sm h-7 font-mono text-[12px] w-[220px]", hasAuth && "pr-6")} value={base} placeholder="http://localhost:3000" spellCheck={false} disabled={!envInfo || savingBase} onChange={(e) => setBase(e.target.value)} onBlur={() => void saveBase()} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
            {hasAuth && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-dim" title={`${envInfo?.auth.type} auth is added to every request`}>{Icon.lock({ size: 11 })}</span>}
          </span>
        </label>
        <button className="btn-subtle btn-xs h-7" onClick={() => setAuthOpen(true)} title="Headers and auth added to every request in this environment">Auth…</button>
      </div>
      <div className="flex-none relative flex flex-col border-b border-border" style={{ height: size }}>
        <RequestEditor key={ep.key} draft={entry.draft} onChange={patch} />
        <ResizeHandle axis="y" className="bottom-0" {...handle} />
      </div>
      <ResponseView res={entry.res} busy={busy} />
      <EnvironmentModal env={authOpen ? env : null} onClose={() => setAuthOpen(false)} onSaved={(e, v) => { if (e === env) { setEnvInfo(v); setBase(v.baseUrl); } }} />
    </div>
  );
}
