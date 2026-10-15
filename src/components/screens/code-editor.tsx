"use client";
// In-app code editor (CodeMirror) that reads + writes one file through GET/PUT /api/projects/[id]/file.
// `CodeEditorPane` fills whatever you put it in (a file tab, or the right half of an endpoint tab).
// Optimistic concurrency via baseHash (409 → "changed on disk"); Ctrl/Cmd+S saves while the pane has focus.
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCmTheme } from "@/components/screens/cm-theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { arkusTheme } from "./cm-theme";
import { Chip, Icon, Kbd, Spinner, useToast } from "@/components/ui";
import { api, ApiError, cx } from "@/lib/ui";
import { useMe, useViewer } from "@/lib/me";

type FileDoc = { path: string; content: string; hash: string; size: number; language: string; readOnly: boolean; reason?: string };
export type EditorCursor = { line: number; col: number; language: string; file: string };

// ---------- CodeMirror pieces ----------
const flashEffect = StateEffect.define<number | null>();
const flashLine = Decoration.line({ class: "cm-arkus-flash" });
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      if (e.value == null) { next = Decoration.none; continue; }
      const ln = tr.state.doc.line(Math.max(1, Math.min(e.value, tr.state.doc.lines)));
      next = Decoration.set([flashLine.range(ln.from)]);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});


function langExt(language: string): Extension[] {
  switch (language) {
    case "typescript": return [javascript({ typescript: true })];
    case "tsx": return [javascript({ typescript: true, jsx: true })];
    case "javascript": return [javascript()];
    case "jsx": return [javascript({ jsx: true })];
    case "json": return [json()];
    case "css": return [css()];
    case "sql": return [sql()];
    case "python": return [python()];
    case "markdown": return [markdown()];
    case "html": return [html()];
    default: return [];
  }
}

// ---------- VS Code link ----------
// vscode://file/<abs>:<line>. VS Code documents forward slashes for Windows too (vscode://file/C:/x/y.ts:12),
// so the href always uses "/" regardless of the root's separator; the title shows the OS-native path.
export function absolutePath(rootPath: string, file: string) {
  const sep = rootPath.includes("\\") ? "\\" : "/";
  const root = rootPath.replace(/[\\/]+$/, "");
  return root + sep + file.replace(/^[\\/]+/, "").split(/[\\/]+/).join(sep);
}
export function vscodeHref(rootPath: string, file: string, line?: number) {
  const abs = absolutePath(rootPath, file).replace(/\\/g, "/").replace(/^\/+/, "");
  return `vscode://file/${encodeURI(abs)}${line ? `:${line}` : ""}`;
}

export function OpenInEditorLink({ file, line, className, label = "VS Code" }: { file: string; line?: number; className?: string; label?: string }) {
  const { project } = useWorkspace();
  const me = useMe();
  if (!project.rootPath || me?.cloud) return null;
  return <a href={vscodeHref(project.rootPath, file, line)} className={cx("btn-subtle btn-xs", className)} title={`Open in VS Code: ${absolutePath(project.rootPath, file)}`}>{Icon.external({ size: 12 })} {label}</a>;
}

// ---------- Pane ----------
export function CodeEditorPane({ file, line, active = true, onDirty, onSaved, onCursor, header = true, className }: { file: string; line?: number; active?: boolean; onDirty?: (dirty: boolean) => void; onSaved?: (r: { path: string; hash: string }) => void; onCursor?: (c: EditorCursor | null) => void; header?: boolean; className?: string }) {
  const cmTheme = useCmTheme();
  const viewer = useViewer();
  const { project } = useWorkspace();
  const { toast } = useToast();
  const [doc, setDoc] = useState<FileDoc | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const viewRef = useRef<EditorView | null>(null);
  const dirty = doc != null && content !== doc.content;
  const dirtyRef = useRef(dirty);
  useEffect(() => { if (dirtyRef.current !== dirty) { dirtyRef.current = dirty; onDirty?.(dirty); } }, [dirty, onDirty]);

  const load = useCallback(async () => {
    setLoadErr(null); setConflict(false);
    try {
      const d = await api<FileDoc>(`/api/projects/${project.slug}/file?path=${encodeURIComponent(file)}`);
      setDoc(d); setContent(d.content); setEditorKey((k) => k + 1);
    } catch (e) { setDoc(null); setLoadErr((e as Error).message); }
  }, [file, project.slug]);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!doc || !dirty || saving) return;
    setSaving(true); setConflict(false);
    try {
      const r = await api<{ ok: true; hash: string; bytes: number; lines?: { added: number; removed: number } }>(`/api/projects/${project.slug}/file`, { method: "PUT", json: { path: doc.path, content, baseHash: doc.hash } });
      setDoc({ ...doc, content, hash: r.hash, size: r.bytes });
      toast({ kind: "ok", title: `Saved ${doc.path.split("/").pop()}`, detail: r.lines ? `+${r.lines.added} −${r.lines.removed} lines · re-index the map to pick up structural changes` : "Re-index the map to pick up structural changes." });
      onSaved?.({ path: doc.path, hash: r.hash });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setConflict(true); toast({ kind: "warn", title: "File changed on disk", detail: "Reload to pick up the newer version; your edits will be discarded." }); }
      else toast({ kind: "error", title: "Could not save", detail: (e as Error).message });
    } finally { setSaving(false); }
  }, [doc, dirty, saving, content, project.slug, toast, onSaved]);

  // Scroll the requested line into view and flash it once the editor exists.
  const onCreate = useCallback((view: EditorView) => {
    viewRef.current = view;
    const n = line && line > 0 ? Math.min(line, view.state.doc.lines) : 0;
    if (!n) return;
    const pos = view.state.doc.line(n).from;
    requestAnimationFrame(() => {
      view.dispatch({ selection: { anchor: pos }, effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashEffect.of(n)] });
      setTimeout(() => { try { view.dispatch({ effects: flashEffect.of(null) }); } catch { /* unmounted */ } }, 1600);
    });
  }, [line]);

  // Cursor → status bar (only while this pane is the active one).
  const cursorExt = useMemo(() => EditorView.updateListener.of((u) => {
    if (!onCursor || !(u.selectionSet || u.focusChanged)) return;
    if (!u.view.hasFocus) return;
    const head = u.state.selection.main.head; const l = u.state.doc.lineAt(head);
    onCursor({ line: l.number, col: head - l.from + 1, language: doc?.language || "text", file });
  }), [onCursor, doc?.language, file]);
  useEffect(() => { if (!active) onCursor?.(null); }, [active, onCursor]);

  const extensions = useMemo(() => [arkusTheme, flashField, cursorExt, ...langExt(doc?.language || "text")], [doc?.language, cursorExt]);

  return (
    <div className={cx("flex-1 min-h-0 flex flex-col bg-bg", className)} onKeyDownCapture={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); void save(); } }}>
      {header && (
        <div className="flex items-center gap-2 px-3 h-8 border-b border-border flex-none bg-surface text-[12px]">
          <span className="font-mono text-muted truncate" title={file}>{file}</span>
          {doc?.readOnly && <Chip tone="amber" title={doc.reason}>read only</Chip>}
          {dirty && <span className="inline-flex items-center gap-1.5 text-[11.5px] text-amber"><span className="w-1.5 h-1.5 rounded-full bg-amber" /> modified</span>}
          <span className="flex-1" />
          <OpenInEditorLink file={file} line={line} />
          <button className={cx("btn-xs dev-only", dirty ? "btn-primary" : "btn-subtle")} disabled={!dirty || saving || !doc || doc.readOnly} onClick={() => void save()} title="Save (Ctrl S)">{saving ? <Spinner /> : Icon.check({ size: 12 })} Save <Kbd>⌃S</Kbd></button>
        </div>
      )}
      {conflict && (
        <div className="flex items-center gap-3 px-3 py-1.5 bg-amber/10 border-b border-amber/30 text-[12px] text-amber flex-none">
          {Icon.warn({ size: 13 })}<span>File changed on disk since you opened it. Reload to see the newer version (your edits will be lost).</span>
          <button className="btn-ghost btn-xs ml-auto" onClick={() => void load()}>{Icon.refresh({ size: 12 })} Reload</button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {loadErr ? <div className="p-6 text-[12.5px] text-red-soft">{loadErr}</div>
          : !doc ? <div className="p-6 flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> Opening file</div>
          : <CodeMirror key={editorKey} value={content} height="100%" style={{ height: "100%" }} theme={cmTheme} extensions={extensions} onChange={setContent} onCreateEditor={onCreate} editable={!doc.readOnly && !viewer} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, bracketMatching: true, autocompletion: false, tabSize: 2 }} />}
      </div>
    </div>
  );
}
