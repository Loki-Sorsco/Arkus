"use client";
// Shared pieces for the endpoint and page tabs: the plain-English writeup (click a step to edit),
// request/response key tables, the "used by" impact block, and the left|code split layout.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CodeEditorPane, type EditorCursor } from "@/components/screens/code-editor";
import { ResizeHandle, useResizable } from "@/components/shell/resize";
import type { Tab } from "@/components/shell/tabs";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, Ref, Spinner, useToast } from "@/components/ui";
import { api, cx, useApi, useLocal } from "@/lib/ui";
import type { GNode } from "@/lib/arkus/types";
import type { Writeup } from "@/lib/arkus/writeups";

export type Impact = { usedBy: Record<string, { key: string; name: string; depth: number }[]>; uses: Record<string, { key: string; name: string }[]>; risk: string; summary: string };
type RefKind = "table" | "column" | "function" | "endpoint" | "page" | "unresolved" | "external";
export const refKind = (t: string): RefKind => (t === "table" || t === "column" ? t : t === "endpoint" ? "endpoint" : t === "external" ? "external" : t === "screen" ? "page" : t === "function" ? "function" : "unresolved");

// ---------- writeup ----------
export function useWriteup(slug: string, key: string) {
  const [data, setData] = useState<Writeup | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (force = false) => {
    if (force) setRegenerating(true); else setLoading(true);
    try { setData(await api<Writeup>(`/api/projects/${slug}/writeup?key=${encodeURIComponent(key)}${force ? "&force=1" : ""}`)); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); setRegenerating(false); }
  }, [slug, key]);
  useEffect(() => { void load(); }, [load]);
  return { data, loading, regenerating, error, regenerate: () => load(true) };
}

export function WriteupView({ ep, writeup, loading, error }: { ep: GNode; writeup: Writeup | null; loading: boolean; error?: string | null }) {
  const { project, addDraft, openNode } = useWorkspace();
  const { toast } = useToast();
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  useEffect(() => { setEdits({}); setEditing(null); }, [writeup]);
  if (loading && !writeup) return <div className="flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> Reading the handler</div>;
  if (!writeup) return <div className="text-[12.5px] text-dim">{error || "No writeup available."}</div>;

  const save = async (i: number, original: string) => {
    const t = text.trim();
    if (!t || t === original) { setEditing(null); return; }
    setSaving(true);
    try {
      const r = await api<{ ok: boolean; error?: string; behaviorChange: boolean }>(`/api/projects/${project.slug}/writeup`, { json: { text: t, endpoint: ep.name, original } });
      if (!r.ok) { toast({ kind: "warn", title: "Not clear enough", detail: r.error }); return; }
      setEdits((e) => ({ ...e, [i]: t }));
      if (r.behaviorChange) addDraft({ label: `update ${ep.name} from writeup`, intent: { kind: "edit_writeup", endpoint: ep.key, before: original, after: t } });
      else toast({ title: "Wording only", detail: "That reads as the same behaviour, so nothing to plan." });
      setEditing(null);
    } catch (e) { toast({ kind: "error", title: "Could not check that", detail: (e as Error).message }); }
    finally { setSaving(false); }
  };
  const refClick = (r: { kind: string; label: string }) => {
    if (r.kind === "table") openNode(`table:${r.label}`);
    else if (r.kind === "column") openNode(`column:${r.label}`);
  };
  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      {writeup.intro && <p className="text-text-2 leading-relaxed prose text-[13px]">{writeup.intro}</p>}
      <ol className="flex flex-col gap-1">
        {writeup.steps.map((s, i) => {
          const cur = edits[i] ?? s.text;
          return (
            <li key={i} className="flex gap-2.5 group">
              <span className="w-5 flex-none text-right text-[11.5px] text-dim tabular-nums pt-[3px]">{i + 1}</span>
              <div className="flex-1 min-w-0">
                {editing === i ? (
                  <textarea autoFocus className="textarea text-[13px] py-1.5 px-2.5" rows={2} value={text} disabled={saving} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(i, cur); } if (e.key === "Escape") setEditing(null); }} onBlur={() => !saving && setEditing(null)} />
                ) : (
                  <div className="rounded-[5px] -mx-1.5 px-1.5 py-0.5 cursor-text hover:bg-surface-2 transition prose" title="Click to edit" onClick={() => { setEditing(i); setText(cur); }}>
                    {s.title && <span className="font-medium text-text">{s.title}. </span>}<span className="text-text-2">{cur}</span>
                  </div>
                )}
                {!!s.refs?.length && <div className="flex flex-wrap gap-1 mt-0.5">{s.refs.map((r, j) => <Ref key={j} kind={r.kind} onClick={r.kind === "table" || r.kind === "column" ? () => refClick(r) : undefined}>{r.label}</Ref>)}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="text-[11.5px] text-dim flex items-center gap-1.5 flex-wrap">
        <span>Who can call: <span className="text-muted">{writeup.auth || "unknown"}</span></span><span>·</span><span>click a step to edit it</span>
        <Chip tone={writeup.source === "ai" ? "accent" : "muted"} className="ml-auto">{writeup.source === "ai" ? "AI" : "static"}</Chip>
      </div>
    </div>
  );
}

// ---------- key tables ----------
export const Td = ({ children, mono, dim, className }: { children: ReactNode; mono?: boolean; dim?: boolean; className?: string }) => <td className={cx("px-2.5 py-1.5 border-b border-border/60 align-middle", mono && "font-mono text-[12px]", dim && "text-dim", className)}>{children}</td>;
const Th = ({ children }: { children: ReactNode }) => <th className="text-left text-[10.5px] font-semibold uppercase tracking-[.06em] text-dim px-2.5 h-7 border-b border-border whitespace-nowrap bg-surface">{children}</th>;
/** Dense table: 12.5px rows, 28px header. */
export function DenseTable({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="border border-border rounded-[6px] overflow-hidden bg-bg-deep/40">
      <table className="w-full text-[12.5px] border-collapse"><thead><tr>{head.map((h) => <Th key={h}>{h}</Th>)}</tr></thead><tbody className="[&_tr:last-child_td]:border-0">{children}</tbody></table>
      {empty}
    </div>
  );
}
export function RequestTable({ rows }: { rows: Writeup["request"] }) {
  if (!rows.length) return <div className="text-[12.5px] text-dim">No request body detected.</div>;
  return <DenseTable head={["Key", "Type", "Validation", "From page field", "Stored in"]}>{rows.map((r) => <tr key={r.key}><Td mono>{r.key}</Td><Td mono dim>{r.type}</Td><Td dim={!r.validation}>{r.validation || "—"}</Td><Td dim={!r.fromField}>{r.fromField || "—"}</Td><Td mono dim={!r.storedIn}>{r.storedIn || "—"}</Td></tr>)}</DenseTable>;
}
export function ResponseTable({ rows }: { rows: Writeup["response"] }) {
  if (!rows.length) return <div className="text-[12.5px] text-dim">No response keys detected.</div>;
  return <DenseTable head={["Key", "Type"]}>{rows.map((r) => <tr key={r.key}><Td mono>{r.key}</Td><Td mono dim>{r.type}</Td></tr>)}</DenseTable>;
}

// ---------- used by ----------
export function ImpactView({ nodeKey }: { nodeKey: string }) {
  const { project, openNode } = useWorkspace();
  const impact = useApi<Impact>(`/api/projects/${project.slug}/impact?key=${encodeURIComponent(nodeKey)}`);
  if (impact.loading && !impact.data) return <Spinner />;
  const d = impact.data; if (!d) return <div className="text-[12.5px] text-dim">{impact.error || "No impact data."}</div>;
  const groups = Object.entries(d.usedBy).filter(([t, l]) => t !== "apicall" && t !== "app" && t !== "component" && l.length);
  const uses = Object.entries(d.uses).flatMap(([t, l]) => (t === "apicall" || t === "column" ? [] : l.map((x) => ({ ...x, t })))).slice(0, 12);
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <div className={cx(d.risk === "high" ? "text-red-soft" : d.risk === "medium" ? "text-amber" : "text-muted")}>{d.summary}{d.risk !== "low" ? ` · ${d.risk} risk to change` : ""}</div>
      {groups.map(([t, list]) => (
        <div key={t} className="flex flex-col gap-1"><span className="text-[10.5px] uppercase tracking-[.06em] text-dim">{t === "screen" ? "pages" : t + "s"}</span>
          <div className="flex flex-wrap gap-1">{list.slice(0, 12).map((x) => <Ref key={x.key} kind={refKind(t)} onClick={() => openNode(x.key)}>{x.name}</Ref>)}{list.length > 12 && <span className="text-[11.5px] text-dim">+{list.length - 12}</span>}</div></div>
      ))}
      {uses.length > 0 && <div className="flex flex-col gap-1"><span className="text-[10.5px] uppercase tracking-[.06em] text-dim">Depends on</span><div className="flex flex-wrap gap-1">{uses.map((x) => <Ref key={x.key} kind={refKind(x.t)} onClick={() => openNode(x.key)}>{x.name}</Ref>)}</div></div>}
    </div>
  );
}

// ---------- left | code split ----------
export function useCodeSplit(storageKey: string) { return useLocal<boolean>(storageKey, true); }
export const SplitIcon = ({ size = 14 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 5h16v14H4zM12 5v14" /></svg>;
export function SplitToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <button className={cx("btn-icon btn-xs", on ? "text-text bg-surface-3" : "text-dim")} onClick={onToggle} title={on ? "Hide code" : "Show code"} aria-pressed={on}><SplitIcon /></button>;
}
/** Scrollable left column + resizable CodeEditorPane on the right (when `file` is set and code is on). */
export function CodeSplit({ tab, file, line, on, resizeKey, children }: { tab: Tab; file?: string; line?: number; on: boolean; resizeKey: string; children: ReactNode }) {
  const { project, updateTab, setEditorStatus } = useWorkspace();
  const { size, handle } = useResizable(resizeKey, 560, { min: 360, max: 1200, axis: "x", invert: true });
  const onDirty = useCallback((d: boolean) => updateTab(tab.id, { dirty: d, preview: false }), [tab.id, updateTab]);
  const onCursor = useCallback((c: EditorCursor | null) => setEditorStatus(c), [setEditorStatus]);
  const showCode = on && !!file && !!project.rootPath;
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 min-h-0 overflow-auto p-4 flex flex-col gap-4">{children}</div>
      {showCode && (
        <div className="flex-none min-h-0 flex flex-col relative border-l border-border" style={{ width: size }}>
          <ResizeHandle axis="x" className="left-0" {...handle} />
          <CodeEditorPane file={file!} line={line} header onDirty={onDirty} onCursor={onCursor} />
        </div>
      )}
    </div>
  );
}
