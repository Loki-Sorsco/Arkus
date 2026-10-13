"use client";
// Right-side drawer that opens one source file in the editor (from the inspector, plans, problems…).
import { useCallback, useEffect, useState } from "react";
import { CodeEditorPane, type EditorCursor } from "@/components/screens/code-editor";
import { Icon, Kbd } from "@/components/ui";
import { useWorkspace } from "./workspace";

export function CodeDrawer() {
  const { codeFile, closeCodeFile, setEditorStatus } = useWorkspace();
  const [dirty, setDirty] = useState(false);
  const onCursor = useCallback((c: EditorCursor | null) => setEditorStatus(c), [setEditorStatus]);
  const close = useCallback(() => { if (dirty && !window.confirm("Discard unsaved changes?")) return; setDirty(false); setEditorStatus(null); closeCodeFile(); }, [dirty, closeCodeFile, setEditorStatus]);
  useEffect(() => { if (!codeFile) return; const h = (e: KeyboardEvent) => { if (e.key === "Escape") close(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [codeFile, close]);
  if (!codeFile) return null;
  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="arise h-full w-[min(1000px,88vw)] bg-bg border-l border-border shadow-[-24px_0_64px_rgba(0,0,0,.55)] flex flex-col" role="dialog" aria-modal="true">
        <div className="flex items-center gap-2 px-3 h-9 border-b border-border flex-none bg-surface text-[12px]">
          <span className="font-mono text-text-2 truncate">{codeFile.path}</span>
          <span className="ml-auto text-[11px] text-dim">close <Kbd>Esc</Kbd></span>
          <button className="btn-icon btn-xs" onClick={close} aria-label="Close">{Icon.close({ size: 14 })}</button>
        </div>
        <CodeEditorPane file={codeFile.path} line={codeFile.line} onDirty={setDirty} onCursor={onCursor} header />
      </div>
    </div>
  );
}
