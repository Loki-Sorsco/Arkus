"use client";
// Workspace shell for V1: three sections (Map · APIs · Database) in a left rail, the section's screen in
// the middle, an optional right panel (Inspect on the map, Ask anywhere), and a status bar. The URL is
// the state: /p/<slug>/<section>?sel=…&view=…. Everything screens share lives in WorkspaceContext.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, cx, useApi, useLocal } from "@/lib/ui";
import { Dot, Icon, Spinner, useToast } from "@/components/ui";
import type { LoadedGraph } from "@/lib/arkus/graph";
import type { PlanIntent } from "@/lib/arkus/plans";
import { fileDir, fileName, type Tab, type TabsState } from "./tabs";
import { CommandPalette } from "./palette";
import { TitleBar } from "./title-bar";
import { Rail } from "./activity-bar";
import { RightPanel } from "./right-panel";
import { StatusBar } from "./status-bar";
import { CodeDrawer } from "./code-drawer";

export type Env = "dev" | "preview" | "prod";
export type Section = "map" | "apis" | "database" | "flows" | "plans" | "activity" | "connect" | "settings";
export const SECTIONS: Section[] = ["map", "apis", "database", "flows", "plans", "activity", "connect", "settings"];
export type ProjectDetail = { id: string; name: string; slug: string; mode: string; status: string; rootPath: string | null; repoUrl: string | null; stack: { summary?: string; frameworks?: string[]; orms?: string[]; dbEngineHint?: string }; sources: { id: string; kind: string; env: string; name: string; status: string; config: Record<string, unknown>; lastError?: string | null; testedAt?: string | null }[]; snapshots: { id: string; kind: string; version: string; status: string; stats: Record<string, unknown>; createdAt: string }[]; plans: { no: number; title: string; pipeline: string; risk: string }[]; draftPlans: number; blueprint: { version: number } | null; ai?: boolean };
export type Draft = { id: string; label: string; intent: PlanIntent };
export type RightPane = "inspect" | "ask" | "closed" | null;
export type EditorStatus = { line: number; col: number; language: string; file: string } | null;
export type OpenOpts = { side?: boolean; preview?: boolean; focus?: boolean };
export type TryRequest = { key: string; method: string; path: string; bodyKeys: { name: string; type?: string }[] };

type Ctx = {
  project: ProjectDetail; reloadProject: () => Promise<void>;
  graph: LoadedGraph | null; graphLoading: boolean; reloadGraph: () => Promise<void>;
  env: Env; setEnv: (e: Env) => void;
  selection: string | null; select: (key: string | null, opts?: { inspect?: boolean }) => void;
  drafts: Draft[]; addDraft: (d: Omit<Draft, "id">) => void; removeDraft: (id: string) => void; clearDrafts: () => void;
  saveDraftsToPlan: () => Promise<void>;
  gate: (fn: () => void | Promise<void>) => void;
  paletteOpen: boolean; setPaletteOpen: (b: boolean) => void;
  // navigation
  section: Section; params: URLSearchParams;
  go: (section: Section, params?: Record<string, string | undefined>, opts?: { replace?: boolean }) => void;
  setParams: (patch: Record<string, string | undefined>) => void;
  openNode: (key: string, opts?: OpenOpts) => void;
  openFile: (path: string, line?: number, opts?: OpenOpts) => void;
  codeFile: { path: string; line?: number } | null; closeCodeFile: () => void;
  // panels
  rightPane: RightPane; setRightPane: (p: RightPane) => void;
  inspectorOpen: boolean; setInspectorOpen: (b: boolean) => void;
  openAsk: (question?: string) => void; askDraft: string | null;
  editorStatus: EditorStatus; setEditorStatus: (s: EditorStatus) => void;
  // compatibility with the tab-era screens: a tab is derived from the URL, openTab navigates
  activeTab: Tab | null; tabs: TabsState;
  openTab: (t: Omit<Tab, "id"> & { id?: string }, opts?: OpenOpts) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  openTryIt: (r: TryRequest) => void;
};
const WorkspaceCtx = createContext<Ctx | null>(null);
export const useWorkspace = () => { const c = useContext(WorkspaceCtx); if (!c) throw new Error("useWorkspace outside WorkspaceProvider"); return c; };

const qs = (p: Record<string, string | undefined>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(p)) if (v != null && v !== "") u.set(k, v); const s = u.toString(); return s ? `?${s}` : ""; };

export function WorkspaceProvider({ slug, initial, children }: { slug: string; initial: ProjectDetail; children: ReactNode }) {
  const [project, setProject] = useState(initial);
  const reloadProject = useCallback(async () => setProject(await api<ProjectDetail>(`/api/projects/${slug}`)), [slug]);
  const g = useApi<LoadedGraph>(`/api/projects/${slug}/graph`);
  const [env, setEnv] = useLocal<Env>(`arkus:${slug}:env`, "dev");
  const [drafts, setDrafts] = useLocal<Draft[]>(`arkus:${slug}:drafts`, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [gateFn, setGateFn] = useState<null | (() => void | Promise<void>)>(null);
  const [rightPane, setRightPane] = useLocal<RightPane>(`arkus:${slug}:right`, null);
  const [askDraft, setAskDraft] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<EditorStatus>(null);
  const [codeFile, setCodeFile] = useState<{ path: string; line?: number } | null>(null);
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = pathname.split("/")[3] || "map";
  const section: Section = (SECTIONS as string[]).includes(raw) ? (raw as Section) : "map";
  const [selection, setSelection] = useState<string | null>(params.get("sel"));
  // The URL's sel wins when it changes (deep links, back button); map clicks update it via replaceState.
  const urlSel = params.get("sel");
  useEffect(() => { if (urlSel !== null) setSelection(urlSel); else if (section !== "map") setSelection(null); }, [urlSel, section]);

  const go = useCallback((s: Section, p: Record<string, string | undefined> = {}, opts?: { replace?: boolean }) => {
    const url = `/p/${slug}/${s}${qs(p)}`;
    if (opts?.replace) router.replace(url); else router.push(url);
  }, [router, slug]);
  const setParams = useCallback((patch: Record<string, string | undefined>) => {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") u.searchParams.delete(k); else u.searchParams.set(k, v); }
    window.history.replaceState(null, "", u.pathname + u.search);
  }, []);

  const select = useCallback((key: string | null, opts?: { inspect?: boolean }) => {
    setSelection(key);
    if (section === "map") setParams({ sel: key || undefined });
    if (key && section === "map" && (opts?.inspect ?? true)) setRightPane((cur) => (cur === "ask" || cur === "closed" ? cur : "inspect"));
  }, [section, setParams, setRightPane]);

  const openFile = useCallback((p: string, line?: number) => setCodeFile({ path: p, line }), []);
  const openNode = useCallback((key: string) => {
    const type = key.split(":")[0];
    if (type === "table") go("database", { view: "table", sel: key });
    else if (type === "column") { const [t, c] = key.slice(7).split("."); go("database", { view: "table", sel: `table:${t}`, column: c }); }
    else if (type === "endpoint") go("apis", { sel: key });
    else if (type === "screen" || type === "external") { go("map", { sel: key }); setSelection(key); setRightPane("inspect"); }
    else { const n = g.data?.nodes.find((x) => x.key === key); if (n?.file) openFile(n.file, n.lineStart); else { setSelection(key); setRightPane("inspect"); } }
  }, [go, g.data, openFile, setRightPane]);

  // Tab-era compatibility: openTab navigates to the section that owns that kind.
  const openTab = useCallback((t: Omit<Tab, "id"> & { id?: string }) => {
    switch (t.kind) {
      case "map": go("map", { sel: t.key }); break;
      case "table": go("database", { view: "table", sel: t.key, column: t.params?.column, filters: t.params?.filters }); break;
      case "endpoint": go("apis", { sel: t.key }); break;
      case "request": go("apis", { sel: t.key?.startsWith("ep:") ? t.key.slice(3) : undefined, view: "test" }); break;
      case "page": go("map", { sel: t.key }); if (t.key) { setSelection(t.key); setRightPane("inspect"); } break;
      case "file": if (t.key) openFile(t.key, t.line); break;
      case "schema": go("database", { view: "diagram", sel: t.key }); break;
      case "query": go("database", { view: "query", id: t.key, sql: t.params?.sql }); break;
      case "history": go("database", { view: "history" }); break;
      case "drift": go("database", { view: "drift" }); break;
      case "ask": setRightPane("ask"); break;
      case "flows": go("flows", { flow: t.key }); break;
      case "plans": go("plans", { no: t.key }); break;
      default: go(t.kind as Section);
    }
  }, [go, openFile, setRightPane]);
  const updateTab = useCallback((_id: string, patch: Partial<Tab>) => { if (patch.params?.sql !== undefined && section === "database") setParams({ sql: patch.params.sql }); }, [section, setParams]);
  const openTryIt = useCallback((r: TryRequest) => go("apis", { sel: r.key, view: "test" }), [go]);

  const activeTab = useMemo<Tab | null>(() => {
    const sel = params.get("sel") || undefined;
    const t = (x: Tab): Tab => x;
    if (section === "apis" && sel) return t({ id: `endpoint:${sel}`, kind: "endpoint", key: sel, label: sel });
    if (section === "database") {
      const view = params.get("view") || (sel ? "table" : "");
      if (view === "table" && sel) return t({ id: `table:${sel}`, kind: "table", key: sel, label: sel.replace(/^table:/, ""), params: { column: params.get("column") || "", filters: params.get("filters") || "" } });
      if (view === "query") { const id = params.get("id") || "q1"; return t({ id: `query:${id}`, kind: "query", key: id, label: "Query", params: { sql: params.get("sql") || "" } }); }
      if (view === "diagram") return { id: "schema", kind: "schema", key: sel, label: "Schema" };
      if (view === "history") return { id: "history", kind: "history", label: "History" };
      if (view === "drift") return { id: "drift", kind: "drift", label: "Drift" };
      return null;
    }
    if (section === "flows") return { id: "flows", kind: "flows", key: params.get("flow") || undefined, label: "Flows" };
    if (section === "plans") return { id: "plans", kind: "plans", key: params.get("no") || undefined, label: "Plans" };
    if (section === "map") return { id: "map", kind: "map", label: "Map", key: sel };
    return { id: section, kind: section as Tab["kind"], label: section };
  }, [section, params]);
  const tabs = useMemo<TabsState>(() => ({ groups: [activeTab ? [activeTab] : []], active: [activeTab?.id ?? null], focus: 0 }), [activeTab]);

  const addDraft = useCallback((d: Omit<Draft, "id">) => { setDrafts([...drafts, { ...d, id: Math.random().toString(36).slice(2) }]); toast({ title: "Unsaved change", detail: d.label }); }, [drafts, setDrafts, toast]);
  const removeDraft = useCallback((id: string) => setDrafts(drafts.filter((d) => d.id !== id)), [drafts, setDrafts]);
  const clearDrafts = useCallback(() => setDrafts([]), [setDrafts]);
  const saveDraftsToPlan = useCallback(async () => {
    if (!drafts.length) return;
    let lastNo: number | null = null;
    for (const d of drafts) { const plan = await api<{ no: number }>(`/api/projects/${slug}/plans`, { json: { intent: d.intent, env } }); lastNo = plan.no; }
    clearDrafts();
    await reloadProject();
    toast({ title: `Plan #${lastNo} drafted`, detail: `${drafts.length} change${drafts.length > 1 ? "s" : ""} saved to plan`, kind: "ok" });
    go("plans", { no: lastNo != null ? String(lastNo) : undefined });
  }, [drafts, slug, env, clearDrafts, reloadProject, toast, go]);
  const gate = useCallback((fn: () => void | Promise<void>) => { if (env === "prod") setGateFn(() => fn); else fn(); }, [env]);
  const openAsk = useCallback((question?: string) => { setAskDraft(question ?? null); setRightPane("ask"); }, [setRightPane]);
  const setInspectorOpen = useCallback((b: boolean) => setRightPane(b ? "inspect" : "closed"), [setRightPane]);

  // Keyboard: ⌘K / ⌘P palette · ⌘L ask · ⌘1/2/3 sections · Esc closes the code drawer
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey; if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "k" || k === "p") { e.preventDefault(); setPaletteOpen((o) => !o); }
      else if (k === "l") { e.preventDefault(); setRightPane((p) => (p === "ask" ? "closed" : "ask")); }
      else if (k === "1") { e.preventDefault(); go("map"); } else if (k === "2") { e.preventDefault(); go("apis"); } else if (k === "3") { e.preventDefault(); go("database"); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [go, setRightPane]);

  const value = useMemo<Ctx>(() => ({
    project, reloadProject, graph: g.data, graphLoading: g.loading, reloadGraph: () => g.reload(true), env, setEnv, selection, select, drafts, addDraft, removeDraft, clearDrafts, saveDraftsToPlan, gate, paletteOpen, setPaletteOpen,
    section, params, go, setParams, openNode, openFile, codeFile, closeCodeFile: () => setCodeFile(null),
    rightPane, setRightPane, inspectorOpen: rightPane === "inspect" || (section === "map" && rightPane === null), setInspectorOpen, openAsk, askDraft, editorStatus, setEditorStatus,
    activeTab, tabs, openTab, updateTab, openTryIt,
  }), [project, reloadProject, g, env, setEnv, selection, select, drafts, addDraft, removeDraft, clearDrafts, saveDraftsToPlan, gate, paletteOpen, section, params, go, setParams, openNode, openFile, codeFile, rightPane, setRightPane, setInspectorOpen, openAsk, askDraft, editorStatus, activeTab, tabs, openTab, updateTab, openTryIt]);

  return (
    <WorkspaceCtx.Provider value={value}>
      <div className="h-screen min-w-[1000px] flex flex-col bg-bg text-text overflow-hidden select-none">
        <TitleBar />
        {env === "prod" && <div className="prod-stripes h-5 flex items-center justify-center text-[11px] font-semibold text-gold tracking-wide flex-none">PRODUCTION · reads are safe · every write needs a typed confirmation</div>}
        <div className="flex-1 min-h-0 flex relative">
          <Rail />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col relative">{children}</div>
          {(rightPane === "ask" || (section === "map" && rightPane !== "closed")) && <RightPanel />}
        </div>
        <EditBar />
        <StatusBar />
        <CommandPalette />
        <CodeDrawer />
        <ProdGate fn={gateFn} onClose={() => setGateFn(null)} />
      </div>
    </WorkspaceCtx.Provider>
  );
}

function EditBar() {
  const { drafts, removeDraft, clearDrafts, saveDraftsToPlan, gate } = useWorkspace();
  const [busy, setBusy] = useState(false);
  if (!drafts.length) return null;
  return (
    <div className="h-10 flex-none flex items-center gap-3 px-4 bg-surface border-t border-accent/40 arise">
      <Dot color="accent" pulse />
      <span className="text-[12.5px] font-semibold">{drafts.length} unsaved change{drafts.length > 1 ? "s" : ""}</span>
      <span className="text-[12px] text-muted truncate">· {drafts.map((d) => d.label).join(" · ")}</span>
      <div className="flex-1" />
      {drafts.length > 1 && <button className="btn-subtle btn-xs" onClick={() => removeDraft(drafts[drafts.length - 1].id)}>Undo last</button>}
      <button className="btn-ghost btn-xs" onClick={() => confirm("Discard all unsaved changes?") && clearDrafts()}>Discard</button>
      <button className="btn-primary btn-xs" disabled={busy} onClick={() => gate(async () => { setBusy(true); try { await saveDraftsToPlan(); } finally { setBusy(false); } })}>{busy ? <Spinner /> : Icon.spark({ size: 13 })} Save to plan</button>
    </div>
  );
}

function ProdGate({ fn, onClose }: { fn: null | (() => void | Promise<void>); onClose: () => void }) {
  const { project } = useWorkspace();
  const [typed, setTyped] = useState("");
  useEffect(() => { if (!fn) setTyped(""); }, [fn]);
  if (!fn) return null;
  return (
    <div className="fixed inset-0 z-[95] bg-black/70 flex items-center justify-center p-6">
      <div className="card arise w-[480px] p-5 border-red/40 shadow-[0_24px_64px_rgba(0,0,0,.6)]">
        <div className="text-[15px] font-semibold text-red-soft">This changes production</div>
        <p className="text-[13px] text-muted mt-1 leading-relaxed prose">Arkus never writes to production without a typed confirmation. Type <span className="font-mono text-text">{project.name}</span> to continue.</p>
        <input autoFocus className="input mt-3 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={project.name} />
        <div className="flex justify-end gap-2 mt-4"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-danger" disabled={typed !== project.name} onClick={async () => { await fn(); onClose(); }}>Continue on prod</button></div>
      </div>
    </div>
  );
}

/** Header of the right-hand inspector pane. */
export function InspectorHeader({ crumb, title, onClose, right }: { crumb?: ReactNode; title: ReactNode; onClose?: () => void; right?: ReactNode }) {
  const { setInspectorOpen } = useWorkspace();
  return (
    <div className="flex-none px-3 h-9 border-b border-border flex items-center gap-2 bg-surface">
      <div className="min-w-0 flex-1">{crumb && <div className="text-[10.5px] text-dim truncate leading-tight uppercase tracking-[.06em]">{crumb}</div>}<div className="text-[12.5px] font-semibold truncate leading-tight">{title}</div></div>
      {right}
      <button className="btn-icon btn-xs -mr-1.5" onClick={onClose || (() => setInspectorOpen(false))} title="Close" aria-label="Close">{Icon.close({ size: 14 })}</button>
    </div>
  );
}

/** Small toolbar row at the top of a screen: 36px, title · meta · actions. */
export function TabToolbar({ title, meta, children, right, className }: { title?: ReactNode; meta?: ReactNode; children?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("h-9 flex-none flex items-center gap-2.5 px-3 border-b border-border bg-surface text-[12.5px]", className)}>
      {title && <span className="font-semibold whitespace-nowrap flex items-center gap-2 min-w-0">{title}</span>}
      {meta && <span className="text-[12px] text-dim whitespace-nowrap truncate">{meta}</span>}
      {children}
      <div className="flex-1" />
      {right && <div className="flex items-center gap-1.5 flex-none">{right}</div>}
    </div>
  );
}

/** Left list pane used by the APIs, Database, Flows and Plans screens. */
export function ListPane({ children, width = 272 }: { children: ReactNode; width?: number }) {
  return <div className="flex-none bg-surface border-r border-border flex flex-col min-h-0 overflow-hidden" style={{ width }}>{children}</div>;
}
export { fileDir, fileName };
