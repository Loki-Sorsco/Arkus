"use client";
// Response half of a request tab: status line (status chip · ms · size · copy), Body | Headers tabs.
// JSON bodies are pretty-printed in a read-only CodeMirror with a fold gutter; "Raw" shows the bytes as sent.
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCmTheme } from "@/components/screens/cm-theme";
import { useMemo, useState } from "react";
import { Chip, CopyButton, EmptyState, Icon, Kbd, Spinner, Tabs, type Tone } from "@/components/ui";
import { cx } from "@/lib/ui";

export type SendResponse = { ok: boolean; status: number; statusText: string; headers: Record<string, string>; body: string; size: number; ms: number; truncated: boolean; finalUrl: string; error?: string; request?: { url: string; headers: Record<string, string> } };

/** Shared CodeMirror look for the API client (oneDark syntax colours on the graphite palette). */
export const cmTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg-deep)", color: "var(--text)", fontSize: "12px", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--bg-deep)", color: "var(--dim)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--muted)" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,.025)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(91,141,239,.28) !important" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(91,141,239,.18)", outline: "1px solid rgba(91,141,239,.4)" },
}, { dark: true });
export const cmSetup = { lineNumbers: true, foldGutter: true, highlightActiveLine: false, highlightActiveLineGutter: false, bracketMatching: true, autocompletion: false, tabSize: 2 } as const;

export const statusTone = (s: number): Tone => (s >= 200 && s < 300 ? "green" : s >= 300 && s < 400 ? "blue" : s >= 400 && s < 500 ? "amber" : "red");
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const pretty = (text: string): string | null => { const t = text.trim(); if (!t || !(t.startsWith("{") || t.startsWith("["))) return null; try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; } };

export function ResponseView({ res, busy }: { res: SendResponse | null; busy: boolean }) {
  const syntaxTheme = useCmTheme();
  const [tab, setTab] = useState<"body" | "headers">("body");
  const [raw, setRaw] = useState(false);
  const json2 = useMemo(() => (res ? pretty(res.body) : null), [res]);
  const extensions = useMemo(() => [cmTheme, json(), EditorView.lineWrapping], []);
  if (!res) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {busy ? <div className="flex-1 flex items-center justify-center gap-2 text-[12.5px] text-dim"><Spinner /> Sending</div>
          : <EmptyState compact title="Send a request to see the response here" hint={<span className="inline-flex items-center gap-1.5">Press <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> to send</span>} />}
      </div>
    );
  }
  const headerRows = Object.entries(res.headers).sort(([a], [b]) => a.localeCompare(b));
  const showJson = tab === "body" && !raw && json2 != null;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-8 flex-none flex items-center gap-2 px-3 border-b border-border text-[12px]">
        <Chip tone={res.status ? statusTone(res.status) : "red"} className="font-mono">{res.status ? `${res.status} ${res.statusText}`.trim() : "failed"}</Chip>
        {busy ? <Spinner /> : <>
          <span className="text-dim tabular-nums">{res.ms} ms</span>
          <span className="text-dim tabular-nums">{fmtSize(res.size)}</span>
          {res.truncated && <Chip tone="amber">truncated to 2 MB</Chip>}
        </>}
        <span className="flex-1" />
        <Tabs size="sm" value={tab} onChange={setTab} items={[{ id: "body", label: "Body" }, { id: "headers", label: "Headers", count: headerRows.length }]} />
        {tab === "body" && json2 != null && <button className={cx("btn-subtle btn-xs", raw && "text-text bg-surface-3")} onClick={() => setRaw((r) => !r)} title="Show the body exactly as received">Raw</button>}
        <CopyButton text={tab === "body" ? res.body : headerRows.map(([k, v]) => `${k}: ${v}`).join("\n")} label="" className="px-1.5" />
      </div>
      {res.error && <div className="flex-none flex items-start gap-1.5 px-3 py-2 text-[12.5px] text-red-soft border-b border-border leading-snug">{Icon.warn({ size: 13, className: "mt-0.5 flex-none" })}<span className="break-all">{res.error}</span></div>}
      {tab === "body" ? (
        showJson ? <div className="flex-1 min-h-0 overflow-hidden"><CodeMirror value={json2} height="100%" style={{ height: "100%" }} theme={syntaxTheme} extensions={extensions} editable={false} basicSetup={cmSetup} /></div>
          : <pre className="flex-1 min-h-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words select-text text-text-2 bg-bg-deep">{res.body || <span className="text-dim">(empty body)</span>}</pre>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto bg-bg-deep">
          <table className="w-full text-[12px] font-mono border-collapse">
            <tbody>
              {headerRows.map(([k, v]) => <tr key={k} className="border-b border-border/60 align-top"><td className="px-3 py-1 text-muted whitespace-nowrap w-[1%]">{k}</td><td className="px-3 py-1 text-text-2 break-all select-text">{v}</td></tr>)}
              {!headerRows.length && <tr><td className="px-3 py-2 text-dim">No headers</td></tr>}
            </tbody>
          </table>
          {res.request && (
            <div className="border-t border-border mt-2">
              <div className="h-6 flex items-center px-3 text-[10.5px] font-semibold uppercase tracking-[.06em] text-dim">Request sent</div>
              <div className="px-3 pb-1 text-[12px] font-mono text-text-2 break-all select-text">{res.request.url}</div>
              <table className="w-full text-[12px] font-mono border-collapse"><tbody>{Object.entries(res.request.headers).map(([k, v]) => <tr key={k} className="border-b border-border/60 align-top"><td className="px-3 py-1 text-muted whitespace-nowrap w-[1%]">{k}</td><td className="px-3 py-1 text-text-2 break-all">{v}</td></tr>)}</tbody></table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
