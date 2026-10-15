"use client";
// Frontend section: the pages of the app (left) · one page (right) · three views — Sketch | Live | Code.
// Sketch is drawn from the graph alone; Live is the running app in an iframe; Code is the page file.
// URL: /p/<slug>/frontend?sel=<screen key>&view=sketch|live|code.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeEditorPane, OpenInEditorLink, type EditorCursor } from "@/components/screens/code-editor";
import { Explainer, HelpButton } from "@/components/shell/explainer";
import { TreeRow } from "@/components/shell/side-panel";
import { ListPane, TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { Chip, EmptyState, Icon, SearchInput, Spinner, Tabs } from "@/components/ui";
import { buildSketch, isFormScreen, screenFields, screenGroup, screenPath } from "@/lib/arkus/sketch";
import type { GBinding, GNode } from "@/lib/arkus/types";
import { useLocal } from "@/lib/ui";
import { PageSketchView } from "./frontend-sketch";
import { FrontendLive } from "./frontend-live";

type View = "sketch" | "live" | "code";
const VIEWS: View[] = ["sketch", "live", "code"];
const asView = (v: string | null): View => (VIEWS.includes(v as View) ? (v as View) : "sketch");
const urlFor = (slug: string, sel: string, view: View) => `/p/${slug}/frontend?sel=${encodeURIComponent(sel)}&view=${view}`;

export function FrontendSection() {
  const { project, graph, graphLoading, select, go: nav } = useWorkspace();
  const sp = useSearchParams();
  const [sel, setSel] = useState<string | null>(() => sp.get("sel"));
  const [view, setView] = useState<View>(() => asView(sp.get("view")));
  const [q, setQ] = useState("");
  const spSel = sp.get("sel"), spView = sp.get("view");
  useEffect(() => { setSel(spSel); setView(asView(spView)); }, [spSel, spView]);

  const pages = useMemo(() => (graph?.nodes || []).filter((n) => n.type === "screen").sort((a, b) => screenPath(a).localeCompare(screenPath(b))), [graph]);
  const page = useMemo(() => (sel ? pages.find((n) => n.key === sel) || null : null), [pages, sel]);

  const go = useCallback((key: string, v: View) => {
    setSel(key); setView(v);
    window.history.replaceState(null, "", urlFor(project.slug, key, v));
    select(key);
  }, [project.slug, select]);
  // No selection in the URL: the first page, without adding a history entry.
  useEffect(() => { if (!page && pages.length && !sel) nav("frontend", { sel: pages[0].key, view }, { replace: true }); }, [page, pages, sel, nav, view]);

  const loading = graphLoading && !graph;
  return (
    <div className="flex-1 min-h-0 flex">
      <PageList pages={pages} bindings={graph?.bindings || []} active={page?.key ?? null} onSelect={(k) => go(k, view)} slug={project.slug} loading={loading} q={q} setQ={setQ} />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {loading ? <div className="flex-1 flex items-center justify-center gap-2 text-[12.5px] text-dim"><Spinner /> Loading map</div>
          : !page ? <EmptyState title={pages.length ? "Pick a page" : "No pages in this map"} hint={pages.length ? "Choose a page on the left." : "Analyse the code to find the screens your app shows."} />
          : <Detail key={page.key} page={page} view={view} setView={(v) => go(page.key, v)} />}
      </div>
    </div>
  );
}

function PageList({ pages, bindings, active, onSelect, slug, loading, q, setQ }: { pages: GNode[]; bindings: GBinding[]; active: string | null; onSelect: (key: string) => void; slug: string; loading: boolean; q: string; setQ: (v: string) => void }) {
  const [open, setOpen] = useLocal<Record<string, boolean>>("arkus:frontend-folders", {});
  const ql = q.trim().toLowerCase();
  const list = useMemo(() => pages.filter((n) => !ql || screenPath(n).toLowerCase().includes(ql) || n.name.toLowerCase().includes(ql)), [pages, ql]);
  const meta = (n: GNode) => { const c = screenFields(n).length; return isFormScreen(n, bindings) ? `form · ${c} field${c === 1 ? "" : "s"}` : "display"; };
  const row = (n: GNode, depth: number) => <TreeRow key={n.key} depth={depth} icon={Icon.pages({ size: 13 })} name={screenPath(n)} meta={meta(n)} active={active === n.key} chevron={null} onClick={() => onSelect(n.key)} title={n.file || n.name} />;
  const body = () => {
    if (loading) return <div className="px-4 py-2"><Spinner /></div>;
    if (!pages.length) return <div className="px-3 py-3 text-[12px] text-dim leading-relaxed prose">No pages found yet · <Link className="link" href={`/import?project=${slug}`}>Analyse the code</Link></div>;
    if (!list.length) return <div className="px-3 py-3 text-[12px] text-dim prose">Nothing matches "{q}".</div>;
    if (pages.length <= 8) return list.map((n) => row(n, 0));
    const m = new Map<string, GNode[]>(); for (const n of list) { const g = screenGroup(n); if (!m.has(g)) m.set(g, []); m.get(g)!.push(n); }
    const folders = [...m.entries()].filter(([, ns]) => ns.length >= 2).sort(([a], [b]) => a.localeCompare(b));
    const singles = [...m.entries()].filter(([, ns]) => ns.length < 2).flatMap(([, ns]) => ns).sort((a, b) => screenPath(a).localeCompare(screenPath(b)));
    return [
      ...folders.map(([g, ns]) => {
        const isOpen = !!ql || open[g] !== false;
        return <div key={g}><TreeRow depth={0} name={g} meta={ns.length} chevron={isOpen ? "open" : "closed"} icon={Icon.folder({ size: 13 })} onClick={() => setOpen((o) => ({ ...o, [g]: !(o[g] !== false) }))} />{isOpen && ns.map((n) => row(n, 1))}</div>;
      }),
      ...singles.map((n) => row(n, 0)),
    ];
  };
  return (
    <ListPane width={272}>
      <div className="px-2 pt-2 pb-1.5 flex-none"><SearchInput value={q} onChange={setQ} placeholder="Filter pages" /></div>
      <div className="flex-1 min-h-0 overflow-auto py-0.5">{body()}</div>
      <div className="h-7 flex-none flex items-center px-3 border-t border-border text-[11.5px] text-dim tabular-nums">{ql && list.length !== pages.length ? `${list.length} of ${pages.length} pages` : `${pages.length} ${pages.length === 1 ? "page" : "pages"}`}</div>
    </ListPane>
  );
}

function Detail({ page, view, setView }: { page: GNode; view: View; setView: (v: View) => void }) {
  const { project, graph, go, setEditorStatus } = useWorkspace();
  const sketch = useMemo(() => (graph ? buildSketch(graph, page.key) : null), [graph, page.key]);
  const form = isFormScreen(page, graph?.bindings || []);
  const hasFile = !!page.file && !!project.rootPath;
  const onCursor = useCallback((c: EditorCursor | null) => setEditorStatus(c), [setEditorStatus]);
  useEffect(() => () => setEditorStatus(null), [setEditorStatus]);
  const path = screenPath(page);
  return (
    <>
      <TabToolbar title={<span className="font-mono font-medium truncate">{path}</span>} meta={page.file ? <span className="font-mono">{page.file}</span> : undefined}
        right={<><HelpButton id="frontend" />
          <Tabs size="sm" value={view} onChange={setView} items={[{ id: "sketch", label: "Sketch" }, { id: "live", label: "Live" }, { id: "code", label: "Code" }]} />
          <button className="btn-subtle btn-xs" onClick={() => go("map", { sel: page.key })} title="Show this page on the map">{Icon.map({ size: 12 })} Show on map</button>
          {page.file && <OpenInEditorLink file={page.file} line={page.lineStart} />}
        </>}>
        <Chip tone={form ? "accent" : "muted"}>{form ? "form" : "display"}</Chip>
      </TabToolbar>
      <Explainer id="frontend" />
      {view === "sketch" && (sketch ? <PageSketchView sketch={sketch} /> : <EmptyState title="Nothing to sketch" hint="This page is not in the map yet." />)}
      {view === "live" && <FrontendLive path={path} />}
      {view === "code" && (hasFile ? <CodeEditorPane file={page.file!} line={page.lineStart} header onCursor={onCursor} /> : <EmptyState title="No source file for this page" hint={!project.rootPath ? "This project has no local folder, so there is nothing to open." : "The index did not record which file renders this page."} />)}
    </>
  );
}
