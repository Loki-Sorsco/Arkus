"use client";
// CodeMirror SQL editor for the query console and the DDL view: dialect picked by engine, schema
// completion from the introspected tables (secret columns left out), Ctrl/Cmd+Enter runs.
import { MySQL, PostgreSQL, SQLite, sql, type SQLNamespace } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { cx } from "@/lib/ui";
import { arkusTheme } from "./cm-theme";
import type { DbTable } from "./db-shared";

export const dialectFor = (engine: string | null | undefined) => (engine === "mysql" ? MySQL : engine === "sqlite" ? SQLite : PostgreSQL);
/** table → columns namespace for completion; pk columns float up, secret columns are left out entirely. */
export const schemaFor = (tables: DbTable[]): SQLNamespace =>
  Object.fromEntries(tables.map((t) => [t.name, t.columns.filter((c) => !c.secret).map((c) => ({ label: c.name, type: "property", detail: c.type || undefined, boost: c.pk ? 1 : 0 }))]));

export function SqlEditor({ value, onChange, engine, tables, onRun, readOnly, placeholder, className, lineNumbers = true, autoFocus }: {
  value: string; onChange?: (v: string) => void; engine: string | null; tables: DbTable[]; onRun?: () => void; readOnly?: boolean; placeholder?: string; className?: string; lineNumbers?: boolean; autoFocus?: boolean;
}) {
  const extensions = useMemo<Extension[]>(() => {
    const ext: Extension[] = [arkusTheme, sql({ dialect: dialectFor(engine), schema: schemaFor(tables), upperCaseKeywords: true })];
    if (readOnly) ext.push(EditorView.editable.of(false));
    return ext;
  }, [engine, tables, readOnly]);
  // Mod-Enter is caught on the way down, before CodeMirror's own keymap (where it inserts a blank line).
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => { if (onRun && (e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onRun(); } };
  return (
    <div className={cx("h-full min-h-0", className)} onKeyDownCapture={keys}>
      <CodeMirror value={value} onChange={onChange} theme={oneDark} extensions={extensions} height="100%" style={{ height: "100%" }} placeholder={placeholder} readOnly={readOnly} editable={!readOnly} autoFocus={autoFocus} className="h-full text-[12.5px]"
        basicSetup={{ lineNumbers, foldGutter: false, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly, bracketMatching: true, autocompletion: !readOnly, tabSize: 2, searchKeymap: false }} />
    </div>
  );
}
