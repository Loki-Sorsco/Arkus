"use client";
// APIs section: one list (left) · one endpoint (right) · three views — Explain | Code | Test.
// The selected endpoint and the view live in the URL (/p/<slug>/apis?sel=<endpoint key>&view=explain|code|test).
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeEditorPane, OpenInEditorLink, type EditorCursor } from "@/components/screens/code-editor";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { RequestTable, ResponseTable, useWriteup, WriteupView } from "@/components/tabs/writeup-view";
import { Chip, EmptyState, Icon, MethodBadge, Ref, Section, Spinner, Tabs } from "@/components/ui";
import type { GNode } from "@/lib/arkus/types";
import { cx } from "@/lib/ui";
import { ApiList, epMethod, epPath } from "./apis-list";
import { ApiTest } from "./apis-test";

type View = "explain" | "code" | "test";
const VIEWS: View[] = ["explain", "code", "test"];
const asView = (v: string | null): View => (VIEWS.includes(v as View) ? (v as View) : "explain");
const urlFor = (slug: string, sel: string, view: View) => `/p/${slug}/apis?sel=${encodeURIComponent(sel)}&view=${view}`;

export function ApisSection() {
  const { project, graph, graphLoading, select } = useWorkspace();
  const sp = useSearchParams();
  const [sel, setSel] = useState<string | null>(() => sp.get("sel"));
  const [view, setView] = useState<View>(() => asView(sp.get("view")));
  const [q, setQ] = useState("");
  // Follow the URL when something else navigates (router push, back/forward).
  const spSel = sp.get("sel"), spView = sp.get("view");
  useEffect(() => { setSel(spSel); setView(asView(spView)); }, [spSel, spView]);

  const endpoints = useMemo(() => (graph?.nodes || []).filter((n) => n.type === "endpoint").sort((a, b) => epPath(a).localeCompare(epPath(b)) || epMethod(a).localeCompare(epMethod(b))), [graph]);
  const ep = useMemo(() => (sel ? endpoints.find((n) => n.key === sel) || null : null), [endpoints, sel]);

  const go = useCallback((key: string, v: View) => {
    setSel(key); setView(v);
    window.history.replaceState(null, "", urlFor(project.slug, key, v));
    select(key);
  }, [project.slug, select]);

  // No (valid) selection: pick the first endpoint.
  useEffect(() => { if (!ep && endpoints.length) go(endpoints[0].key, view); }, [ep, endpoints, go, view]);

  const loading = graphLoading && !graph;
  return (
    <div className="flex-1 min-h-0 flex">
      <ApiList endpoints={endpoints} active={ep?.key ?? null} onSelect={(k) => go(k, view)} slug={project.slug} loading={loading} q={q} setQ={setQ} />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {loading ? <div className="flex-1 flex items-center justify-center gap-2 text-[12.5px] text-dim"><Spinner /> Loading map</div>
          : !ep ? <EmptyState title={endpoints.length ? "Pick an API" : "No APIs in this map"} hint={endpoints.length ? "Choose an endpoint on the left." : "Analyse the code to find the routes your app exposes."} />
          : <Detail key={ep.key} ep={ep} view={view} setView={(v) => go(ep.key, v)} />}
      </div>
    </div>
  );
}

function Detail({ ep, view, setView }: { ep: GNode; view: View; setView: (v: View) => void }) {
  const { project, setEditorStatus } = useWorkspace();
  const auth = ep.attrs?.auth;
  const hasFile = !!ep.file && !!project.rootPath;
  const onCursor = useCallback((c: EditorCursor | null) => setEditorStatus(c), [setEditorStatus]);
  useEffect(() => () => setEditorStatus(null), [setEditorStatus]);
  return (
    <>
      <TabToolbar title={<><MethodBadge method={epMethod(ep)} /><span className="font-mono font-medium truncate">{epPath(ep)}</span></>} meta={ep.attrs?.framework ? String(ep.attrs.framework) : undefined}
        right={<>
          <Tabs size="sm" value={view} onChange={setView} items={[{ id: "explain", label: "Explain" }, { id: "code", label: "Code" }, { id: "test", label: "Test" }]} />
          {ep.file && <OpenInEditorLink file={ep.file} line={ep.lineStart} />}
        </>}>
        <Chip tone={auth === true ? "green" : auth === false ? "amber" : "muted"}>{auth === true ? "auth required" : auth === false ? "public" : "auth unknown"}</Chip>
      </TabToolbar>
      {view === "explain" && <Explain ep={ep} onCode={() => setView("code")} />}
      {view === "code" && (hasFile ? <CodeEditorPane file={ep.file!} line={ep.lineStart} header onCursor={onCursor} /> : <EmptyState title="No source file for this endpoint" hint={!project.rootPath ? "This project has no local folder, so there is nothing to open." : "The index did not record where this route is handled."} />)}
      {view === "test" && <ApiTest ep={ep} />}
    </>
  );
}

type BodyKey = { name: string; type?: string; required?: boolean };
function Explain({ ep, onCode }: { ep: GNode; onCode: () => void }) {
  const { graph, project, openNode } = useWorkspace();
  const w = useWriteup(project.slug, ep.key);
  const bodyKeys = (ep.attrs?.bodyKeys as BodyKey[] | undefined) || [];
  const responseKeys = (ep.attrs?.responseKeys as { name: string; type?: string }[] | undefined) || [];
  const { tables, pages, externals } = useMemo(() => {
    const byKey = new Map((graph?.nodes || []).map((n) => [n.key, n]));
    const merged = new Map<string, { key: string; name: string; write: boolean }>();
    const pages: { key: string; name: string }[] = [], externals: { key: string; name: string }[] = [];
    for (const e of graph?.edges || []) {
      if (e.from === ep.key && (e.type === "reads" || e.type === "writes")) { const cur = merged.get(e.to); merged.set(e.to, { key: e.to, name: byKey.get(e.to)?.name || e.to.replace(/^table:/, ""), write: !!cur?.write || e.type === "writes" }); }
      else if (e.from === ep.key && e.to.startsWith("external:")) externals.push({ key: e.to, name: byKey.get(e.to)?.name || e.to.replace(/^external:/, "") });
      else if (e.to === ep.key && e.type === "calls" && e.from.startsWith("screen:")) pages.push({ key: e.from, name: byKey.get(e.from)?.name || e.from.replace(/^screen:/, "") });
    }
    return { tables: [...merged.values()], pages, externals };
  }, [graph, ep.key]);
  const confidence = Math.round((ep.confidence ?? 1) * 100);
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="px-6 py-5 max-w-[920px] flex flex-col gap-5">
        <Section title="What it does" right={<button className="btn-subtle btn-xs" disabled={w.regenerating || w.loading} onClick={() => void w.regenerate()} title="Re-read the handler and rewrite the explanation">{w.regenerating ? <Spinner /> : Icon.refresh({ size: 12 })} Regenerate</button>}>
          <WriteupView ep={ep} writeup={w.data} loading={w.loading} error={w.error} />
        </Section>
        <Section title="Request"><RequestTable rows={w.data?.request || bodyKeys.map((b) => ({ key: b.name, type: b.type || "unknown", validation: b.required ? "required" : undefined }))} /></Section>
        <Section title="Response"><ResponseTable rows={w.data?.response || responseKeys.map((r) => ({ key: r.name, type: r.type || "unknown" }))} /></Section>
        <Section title="Connected to">
          <div className="grid grid-cols-3 gap-4 text-[12.5px]">
            <Column label="Tables" empty="No tables detected">
              {tables.map((t) => <div key={t.key} className="flex items-center gap-1.5 min-w-0"><Ref kind="table" onClick={() => openNode(t.key)}>{t.name}</Ref>{t.write && <Chip tone="amber">writes</Chip>}</div>)}
            </Column>
            <Column label="Pages that call it" empty="No page calls this directly">
              {pages.map((p) => <Ref key={p.key} kind="page" onClick={() => openNode(p.key)}>{p.name}</Ref>)}
            </Column>
            <Column label="External services" empty="No external services">
              {externals.map((x) => <Ref key={x.key} kind="external" onClick={() => openNode(x.key)}>{x.name}</Ref>)}
            </Column>
          </div>
        </Section>
        <Section title="Details">
          <div className="flex items-center gap-2 text-[12.5px] flex-wrap">
            {ep.file ? <span className={cx("font-mono text-text-2", project.rootPath && "cursor-pointer hover:text-accent")} onClick={project.rootPath ? onCode : undefined} title={project.rootPath ? "Open the code view" : undefined}>{ep.file}{ep.lineStart ? `:${ep.lineStart}` : ""}</span> : <span className="text-dim">no source file</span>}
            {!!ep.attrs?.handlerName && <><span className="text-dim">·</span><span className="font-mono text-muted">{String(ep.attrs.handlerName)}</span></>}
            <span className="text-dim">·</span>
            <span className={cx(confidence >= 90 ? "text-muted" : confidence >= 60 ? "text-amber" : "text-red-soft")}>{confidence}% confidence</span>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Column({ label, empty, children }: { label: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <span className="text-[10.5px] uppercase tracking-[.06em] text-dim">{label}</span>
      {children.length ? <div className="flex flex-wrap gap-1">{children}</div> : <span className="text-dim">{empty}</span>}
    </div>
  );
}
