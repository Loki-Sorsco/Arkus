"use client";
// Action cards for Ask: one card per proposed change (row / column / code / SQL) with a preview, Apply (through
// the prod gate) and Skip; plus the Publish bar for projects cloned from a git URL (opens a pull request).
// Local-folder projects never see the bar: a saved file is simply on disk.
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, CopyButton, Icon, Spinner, type Tone } from "@/components/ui";
import { arkusTheme, useCmTheme } from "@/components/screens/cm-theme";
import { langExt } from "@/components/screens/code-editor";
import { api, cx } from "@/lib/ui";
import type { Action } from "@/lib/arkus/actions";
import type { SchemaChange } from "@/lib/arkus/ddl";

export type ActionState = { status: "pending" | "applying" | "applied" | "skipped" | "error"; error?: string; result?: Record<string, unknown>; published?: boolean };
export type PublishState = { isRepo: boolean; mode: "local" | "pr" | "branch"; branch: string | null; remote: string | null; dirty: number; reason?: string };
type PublishResp = { ok: boolean; mode: string; branch?: string; commit?: string; prUrl?: string; prNumber?: number; note?: string; error?: string; pushed?: boolean };

/** Mirrors CHANGE_RE on the server: does this message ask for a change rather than an explanation? */
export const isChangeRequest = (q: string) => /^\s*(?:please\s+|can you\s+|could you\s+|pls\s+)?(?:add|create|insert|update|change|rename|make|delete|remove|new|set|write|generate|build|drop|alter|append|modify|edit|fix|implement)\b/i.test(q);

const KIND: Record<Action["kind"], { label: string; tone: Tone }> = { insert_row: { label: "Row", tone: "teal" }, update_row: { label: "Row", tone: "teal" }, schema: { label: "Schema", tone: "purple" }, write_file: { label: "Code", tone: "blue" }, run_sql: { label: "SQL", tone: "amber" } };
const LANG: Record<string, string> = { ts: "typescript", mts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", json: "json", css: "css", scss: "css", md: "markdown", py: "python", sql: "sql", html: "html" };
const langOf = (p: string) => LANG[p.split(".").pop()?.toLowerCase() || ""] || "text";
const lit = (v: unknown) => v === null || v === undefined ? "NULL" : typeof v === "string" ? `'${v}'` : String(v);

/** Drops need the table name typed before Apply is enabled. */
export const isDrop = (c: SchemaChange) => c.kind === "drop_table" || c.kind === "drop_column";
/** The table a schema change leaves behind (for the Open table link). */
const schemaTable = (c: SchemaChange) => (c.kind === "rename_table" ? c.to : c.kind === "drop_table" ? null : c.table);
export function describeChange(c: SchemaChange): string {
  switch (c.kind) {
    case "create_table": return `Create table ${c.table} (${c.columns.length} column${c.columns.length === 1 ? "" : "s"})`;
    case "rename_table": return `Rename table ${c.table} to ${c.to}`;
    case "drop_table": return `Drop table ${c.table}`;
    case "add_column": return `Add column ${c.table}.${c.column} (${c.type}${c.nullable === false ? ", not null" : ""}${c.unique ? ", unique" : ""})`;
    case "rename_column": return `Rename ${c.table}.${c.column} to ${c.to}`;
    case "alter_column": return `Alter ${c.table}.${c.column}`;
    case "drop_column": return `Drop column ${c.table}.${c.column}`;
    case "create_index": return `Create ${c.unique ? "unique " : ""}index on ${c.table} (${c.columns.join(", ")})`;
    case "drop_index": return `Drop index ${c.name} on ${c.table}`;
  }
}
export function summarize(a: Action): string {
  if (a.kind === "insert_row") return `Insert a row into ${a.table}`;
  if (a.kind === "update_row") return `Update ${a.table} where ${a.pk.name} = ${lit(a.pk.value)}`;
  if (a.kind === "schema") return describeChange(a.change);
  if (a.kind === "write_file") return a.summary || `${a.create ? "Create" : "Edit"} ${a.path}`;
  return `Run ${a.sql.split(/\s+/).slice(0, 3).join(" ")} …`;
}

/** Tiny line diff (LCS, capped) for the "changed content" preview of an overwrite. */
function lineDiff(a: string, b: string): { t: " " | "+" | "-"; s: string }[] | null {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  if (A.length * B.length > 1_500_000) return null;
  const dp: Uint16Array[] = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: " " | "+" | "-"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) { if (A[i] === B[j]) { out.push({ t: " ", s: A[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: A[i++] }); else out.push({ t: "+", s: B[j++] }); }
  while (i < A.length) out.push({ t: "-", s: A[i++] });
  while (j < B.length) out.push({ t: "+", s: B[j++] });
  return out;
}

function FilePreview({ a }: { a: Extract<Action, { kind: "write_file" }> }) {
  const { project } = useWorkspace();
  const cmTheme = useCmTheme();
  const [current, setCurrent] = useState<string | null | undefined>(a.create ? null : undefined);
  useEffect(() => {
    if (a.create) return;
    let on = true;
    api<{ content: string }>(`/api/projects/${project.slug}/file?path=${encodeURIComponent(a.path)}`).then((d) => { if (on) setCurrent(d.content); }).catch(() => { if (on) setCurrent(null); });
    return () => { on = false; };
  }, [a.create, a.path, project.slug]);
  const diff = useMemo(() => (typeof current === "string" ? lineDiff(current, a.content) : null), [current, a.content]);
  const extensions = useMemo(() => [arkusTheme, ...langExt(langOf(a.path))], [a.path]);
  if (current === undefined) return <div className="text-[12px] text-dim flex items-center gap-2 p-2"><Spinner /> Comparing with the current file</div>;
  if (diff) {
    const changed = diff.filter((l) => l.t !== " ").length;
    return (
      <div className="max-h-[240px] overflow-auto bg-bg-deep border border-border rounded-[6px] font-mono text-[11.5px] leading-[1.5]">
        <div className="px-2 py-1 text-dim border-b border-border">{changed} changed line{changed === 1 ? "" : "s"} · unchanged lines dimmed</div>
        {diff.map((l, i) => <div key={i} className={cx("px-2 whitespace-pre", l.t === "+" ? "bg-green/10 text-green" : l.t === "-" ? "bg-red/10 text-red-soft line-through" : "text-dim")}>{l.t} {l.s}</div>)}
      </div>
    );
  }
  return <div className="max-h-[240px] overflow-auto border border-border rounded-[6px]"><CodeMirror value={a.content} theme={cmTheme} extensions={extensions} readOnly editable={false} basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }} /></div>;
}

function Preview({ a }: { a: Action }) {
  const { project, env } = useWorkspace();
  const engine = (project.sources.find((s) => s.kind === "db" && s.env === env)?.config.engine as string | undefined) || project.stack.dbEngineHint;
  if (a.kind === "insert_row" || a.kind === "update_row") {
    const rows = Object.entries(a.kind === "insert_row" ? a.values : a.set);
    return (
      <table className="w-full text-[12px] border border-border rounded-[6px] overflow-hidden"><tbody>
        {a.kind === "update_row" && <tr className="bg-surface-2"><td className="px-2 py-1 font-mono text-dim">{a.pk.name}</td><td className="px-2 py-1 font-mono text-muted">= {lit(a.pk.value)} (key)</td></tr>}
        {rows.map(([k, v]) => <tr key={k} className="border-t border-border"><td className="px-2 py-1 font-mono text-muted w-[40%] align-top">{k}</td><td className="px-2 py-1 font-mono text-text break-all">{v === null ? <span className="text-dim">NULL</span> : String(v)}</td></tr>)}
      </tbody></table>
    );
  }
  if (a.kind === "schema" || a.kind === "run_sql") {
    const sql = a.kind === "schema" ? a.sql.map((s) => s + ";").join("\n") : a.sql;
    return <pre className="font-mono text-[12px] bg-bg-deep border border-border rounded-[6px] p-2 whitespace-pre-wrap break-all text-text-2" title={engine ? `rendered for ${engine}` : undefined}>{sql}</pre>;
  }
  return <FilePreview a={a} />;
}

export function ActionCard({ action: a, state, onApply, onSkip }: { action: Action; state: ActionState; onApply: (confirm?: string) => void; onSkip: () => void }) {
  const { openNode, openFile, project } = useWorkspace();
  const [typed, setTyped] = useState("");
  const k = KIND[a.kind];
  const done = state.status === "applied";
  const local = done && a.kind === "write_file" && Boolean(state.result?.local);
  const drop = a.kind === "schema" && isDrop(a.change) ? a.change.table : null;
  const tableLink = done ? (a.kind === "insert_row" || a.kind === "update_row" ? a.table : a.kind === "schema" ? schemaTable(a.change) : a.kind === "run_sql" && state.result?.table ? String(state.result.table) : null) : null;
  return (
    <div className={cx("card p-2.5 flex flex-col gap-2", done && "border-green/30", state.status === "skipped" && "opacity-60")}>
      <div className="flex items-center gap-2 min-w-0">
        <Chip tone={k.tone}>{k.label}</Chip>
        <span className="text-[12.5px] font-medium truncate" title={summarize(a)}>{summarize(a)}</span>
        <span className="flex-1" />
        {done && <Chip tone="green">{Icon.check({ size: 11 })} Applied</Chip>}
        {state.status === "skipped" && <Chip tone="muted">Skipped</Chip>}
      </div>
      {a.why && <div className="text-[12px] text-muted prose leading-relaxed">{a.why}</div>}
      {state.status !== "skipped" && <Preview a={a} />}
      {state.error && <div className="text-[12px] text-red-soft prose">{state.error}</div>}
      {local && <div className="text-[12px] text-muted prose">{state.result?.upload ? "Saved to your Arkus copy." : <>Saved to <span className="font-mono text-text-2">{a.path}</span>. Commit it with git when you are ready.</>}</div>}
      {drop && !done && state.status !== "skipped" && (
        <label className="flex items-center gap-2 text-[12px] text-amber"><span className="flex-none">This deletes data. Type <span className="font-mono">{drop}</span> to enable Apply:</span><input className="input input-sm font-mono text-[12px] flex-1 min-w-0" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={drop} /></label>
      )}
      <div className="flex items-center gap-1.5">
        {tableLink && <button className="btn-subtle btn-xs -ml-2" onClick={() => openNode(`table:${tableLink}`)}>{Icon.table({ size: 12 })} Open table</button>}
        {done && a.kind === "write_file" && project.rootPath && <button className="btn-subtle btn-xs -ml-2" onClick={() => openFile(a.path)}>{Icon.pages({ size: 12 })} Open file</button>}
        <span className="flex-1" />
        {(state.status === "pending" || state.status === "error" || state.status === "applying") && <>
          <button className="btn-ghost btn-xs" disabled={state.status === "applying"} onClick={onSkip}>Skip</button>
          <button className={cx("btn-xs dev-only", drop ? "btn-danger" : "btn-primary")} disabled={state.status === "applying" || (drop !== null && typed !== drop)} onClick={() => onApply(drop ? typed : undefined)}>{state.status === "applying" ? <Spinner /> : Icon.check({ size: 12 })} {state.status === "error" ? "Retry" : "Apply"}</button>
        </>}
      </div>
    </div>
  );
}

export function PublishBar({ count, summaries, onPublished }: { count: number; summaries: string[]; onPublished: () => void }) {
  const { project } = useWorkspace();
  const [state, setState] = useState<PublishState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResp | null>(null);
  const defaultMsg = useMemo(() => summaries.filter(Boolean).slice(0, 3).join("; ").slice(0, 120) || "Changes made in Arkus", [summaries]);
  useEffect(() => { let on = true; api<PublishState>(`/api/projects/${project.slug}/git/publish`).then((s) => { if (on) setState(s); }).catch(() => { if (on) setState(null); }); return () => { on = false; }; }, [project.slug, count]);
  if (!project.repoUrl || !state || state.mode === "local" || !state.isRepo) return null;
  const pr = state.mode === "pr";
  const run = async () => {
    setBusy(true); setResult(null);
    try { const r = await api<PublishResp>(`/api/projects/${project.slug}/git/publish`, { json: { message: message.trim() || defaultMsg, summaries } }); setResult(r); if (r.ok) onPublished(); }
    catch (e) { setResult({ ok: false, mode: state.mode, error: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const fallback = [`git checkout -b arkus/${project.slug}`, "git add -A", `git commit -m "${(message.trim() || defaultMsg).replace(/"/g, "'")}"`, `git push -u origin arkus/${project.slug}`].join("\n");
  return (
    <div className="flex-none border-t border-accent/40 bg-surface px-3 py-2 flex flex-col gap-1.5 arise">
      {result?.ok ? (
        <div className="text-[12.5px] flex items-center gap-2 flex-wrap">
          <Chip tone="green">{Icon.check({ size: 11 })} {pr && result.prNumber ? `Pull request #${result.prNumber} opened` : `Branch ${result.branch} pushed`}</Chip>
          {result.prUrl && <a className="text-accent hover:underline" href={result.prUrl} target="_blank" rel="noreferrer">{result.prUrl.replace(/^https:\/\//, "")}</a>}
          {!result.prUrl && result.note && <span className="text-muted">{result.note}</span>}
          {result.commit && <span className="font-mono text-dim">{result.commit}</span>}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="font-semibold">{count} code change{count === 1 ? "" : "s"} not published</span>
            <span className="text-dim">· {pr ? "GitHub" : state.remote || "git"}{state.branch ? ` · from ${state.branch}` : ""}</span>
            <span className="flex-1" />
            <button className="btn-primary btn-xs dev-only" disabled={busy || !count} onClick={() => void run()}>{busy ? <Spinner /> : Icon.git({ size: 12 })} {pr ? "Open pull request" : "Push branch"}</button>
          </div>
          <input className="input input-sm font-mono text-[12px]" value={message} placeholder={defaultMsg} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
          {result && !result.ok && (
            <div className="flex items-start gap-2 text-[12px] text-red-soft prose">
              <span className="flex-1">{result.error}</span>
              <CopyButton text={fallback} label="Copy git commands" className="flex-none" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
