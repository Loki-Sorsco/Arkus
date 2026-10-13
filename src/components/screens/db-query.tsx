"use client";
// Query console: one compact English → SQL line (never auto-run, offline starters) · CodeMirror SQL
// editor with schema completion (Cmd/Ctrl+Enter runs) · Run / Explain / Export toolbar · results below
// a draggable split · footer with count, ms, copy as JSON · collapsible right column with Saved queries
// and History (db-query-side.tsx).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { ResizeHandle, useResizable } from "@/components/shell/resize";
import { Chip, EmptyState, Field, Icon, Kbd, Modal, Spinner, useToast } from "@/components/ui";
import { cx, fmtNum, useApi, useLocal } from "@/lib/ui";
import { dbBase, exportRows, LockChip, post, ResultsTable, type DbTable, type Row, type SavedQuery } from "./db-shared";
import { SqlEditor } from "./db-sql-editor";
import { QuerySide, type QueryAction } from "./db-query-side";

type Starter = { name: string; sql: string };
type RunResp = { ok: boolean; id?: string; sql?: string; columns?: string[]; hidden?: string[]; masked?: string[]; rows?: Row[]; rowCount?: number; ms?: number; truncated?: boolean; limit?: number; blocked?: boolean; reason?: string; error?: string; schemaOnly?: boolean };
type AskResp = { ok: boolean; sql?: string | null; explanation?: string | null; assumptions?: string[]; tables?: string[]; reason?: string; starters?: Starter[]; error?: string };
type ExplainResp = { ok: boolean; plan?: string[]; engine?: string; ms?: number; reason?: string; error?: string };

export function QueryTab({ sql, setSql, tables, engine, schemaOnly }: { sql: string; setSql: (s: string) => void; tables: DbTable[]; engine: string | null; schemaOnly: boolean }) {
  const { project, env } = useWorkspace();
  const { toast } = useToast();
  const base = dbBase(project.slug);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState<AskResp | null>(null);
  const [running, setRunning] = useState<"run" | "explain" | null>(null);
  const [res, setRes] = useState<RunResp | null>(null);
  const [plan, setPlan] = useState<ExplainResp | null>(null);
  const [naming, setNaming] = useState<SavedQuery | null>(null);
  const [name, setName] = useState("");
  const [sideOpen, setSideOpen] = useLocal<boolean>("arkus:ui:query-side", true);
  const split = useResizable("query-split", 220, { min: 96, max: 720, axis: "y" });
  const side = useResizable("query-side", 280, { min: 220, max: 520, axis: "x", invert: true });
  const lists = useApi<{ history: SavedQuery[]; saved: SavedQuery[] }>(`${base}/queries?env=${env}`);
  const refresh = useCallback(() => lists.reload(true), [lists]);

  const doAsk = async () => {
    if (!question.trim()) return;
    setAsking(true); setAsk(null);
    try {
      const r = await post<AskResp>(`${base}/query`, { env, question });
      if (r.error && !r.reason) throw new Error(r.error);
      setAsk(r);
      if (r.ok && r.sql) { setSql(r.sql); setRes(null); setPlan(null); }
    } catch (e) { toast({ title: "Could not generate SQL", detail: (e as Error).message, kind: "error" }); }
    finally { setAsking(false); }
  };
  const run = useCallback(async (override?: string) => {
    const stmt = override ?? sql;
    if (!stmt.trim() || running || schemaOnly) return;
    setRunning("run"); setPlan(null);
    try {
      const r = await post<RunResp>(`${base}/query`, { env, sql: stmt, ...(ask?.ok && ask.sql === stmt ? { question } : {}) });
      setRes(r);
      refresh();
      if (!r.ok && r.error && !r.blocked) toast({ title: "Query failed", detail: r.error, kind: "error" });
    } catch (e) { toast({ title: "Query failed", detail: (e as Error).message, kind: "error" }); }
    finally { setRunning(null); }
  }, [sql, running, schemaOnly, base, env, ask, question, refresh, toast]);
  const explain = async () => {
    if (!sql.trim() || running) return;
    setRunning("explain");
    try { const r = await post<ExplainResp>(`${base}/explain`, { env, sql }); setPlan(r); if (!r.ok && r.error && !r.reason) toast({ title: "Explain failed", detail: r.error, kind: "error" }); }
    catch (e) { toast({ title: "Explain failed", detail: (e as Error).message, kind: "error" }); }
    finally { setRunning(null); }
  };
  const act = async (action: QueryAction, q: SavedQuery, newName?: string) => {
    try { const r = await post<{ ok?: boolean; error?: string }>(`${base}/queries`, { action, id: q.id, name: newName }); if (r.error) throw new Error(r.error); refresh(); }
    catch (e) { toast({ title: `Could not ${action}`, detail: (e as Error).message, kind: "error" }); }
  };
  const saveName = async () => { if (!naming) return; await act(naming.saved ? "rename" : "save", naming, name.trim() || undefined); setNaming(null); toast({ title: "Query saved", kind: "ok" }); };
  const load = (q: SavedQuery) => { setSql(q.sql); setRes(null); setPlan(null); };
  const copyJson = async () => {
    if (!res?.rows) return;
    try { await navigator.clipboard.writeText(JSON.stringify(res.rows, null, 2)); toast({ title: `Copied ${fmtNum(res.rows.length)} rows as JSON`, kind: "ok" }); }
    catch { toast({ title: "Could not copy", detail: "Clipboard access was refused by the browser.", kind: "error" }); }
  };
  useEffect(() => { setRes(null); setPlan(null); setAsk(null); }, [env]);

  const starters = ask && !ask.ok ? ask.starters || [] : [];
  const off = schemaOnly || !tables.length;
  const saved = lists.data?.saved || [], history = lists.data?.history || [];

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* English → SQL: one compact line */}
        <div className="flex-none flex items-center gap-2 px-3 h-9 border-b border-border bg-surface text-[12.5px]">
          <span className="text-muted flex-none">{Icon.spark({ size: 13 })}</span>
          {project.ai === false ? (
            <><span className="text-muted truncate">Ask in English is off. Write SQL below, or add a free Groq key to turn a question into a query.</span><span className="flex-1" /><Link href={`/p/${project.slug}/settings`} className="btn-subtle btn-xs flex-none">Turn on AI</Link></>
          ) : (
            <>
              <input className="input h-7 text-[12.5px] flex-1 min-w-0 bg-transparent border-transparent focus:border-border-strong" placeholder={tables.length ? `Ask in English, e.g. how many ${tables[0].name} were created this week?` : "Connect a database first"} value={question} disabled={!tables.length} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAsk(); }} />
              <button className="btn-ghost btn-xs flex-none" disabled={asking || !question.trim() || !tables.length} onClick={doAsk}>{asking ? <Spinner /> : Icon.spark({ size: 12 })} Generate SQL</button>
            </>
          )}
        </div>
        {ask?.ok && (
          <div className="flex-none flex items-center gap-2 px-3 h-7 border-b border-border bg-surface text-[12px] text-text-2 arise min-w-0">
            <span className="truncate" title={[ask.explanation, ask.assumptions?.length ? `Assumed: ${ask.assumptions.join(" · ")}` : ""].filter(Boolean).join("\n")}>{ask.explanation}{!!ask.assumptions?.length && <span className="text-dim"> · assumed: {ask.assumptions.join(" · ")}</span>}</span>
            <span className="flex-1" /><span className="text-dim flex-none">Generated, not run. Review it, then press Run.</span>
          </div>
        )}
        {ask && !ask.ok && (
          <div className="flex-none flex items-center gap-2 px-3 h-7 border-b border-border bg-surface text-[12px] arise min-w-0">
            <span className="text-amber truncate">{ask.reason}{ask.reason === "AI not configured" ? ". Add a Groq key under Settings → AI, or start from:" : ""}</span>
            {starters.slice(0, 3).map((s) => <Chip key={s.name} tone="muted" onClick={() => { setSql(s.sql); setRes(null); setPlan(null); }} title={s.sql}>{s.name}</Chip>)}
          </div>
        )}
        {/* editor over a draggable split */}
        <div className="flex-none relative flex flex-col min-h-0 border-b border-border" style={{ height: split.size }}>
          <SqlEditor value={sql} onChange={setSql} engine={engine} tables={tables} onRun={() => void run()} placeholder={`SELECT * FROM ${tables[0]?.name || "table"} LIMIT 50`} />
          <ResizeHandle axis="y" className="bottom-0" {...split.handle} />
        </div>
        <div className="flex-none flex items-center gap-2 px-3 h-9 border-b border-border bg-surface text-[12px]">
          <button className="btn-primary btn-xs" disabled={!sql.trim() || !!running || off} onClick={() => void run()}>{running === "run" ? <Spinner /> : Icon.play({ size: 12 })} Run <Kbd>⌃↵</Kbd></button>
          <button className="btn-ghost btn-xs" disabled={!sql.trim() || !!running || off} onClick={explain}>{running === "explain" ? <Spinner /> : null} Explain</button>
          <span className="text-dim truncate">Reads only: one SELECT, limit 1000{engine ? ` · ${engine}` : ""}.</span>
          {schemaOnly && <span className="text-amber truncate">Schema-only connection: queries are off for {env}.</span>}
          <div className="flex-1" />
          {res?.ok && !!res.rows?.length && <button className="btn-subtle btn-xs" onClick={() => exportRows(res.rows!, res.columns || [], "csv", `${project.slug}-${env}-query`)}>Export CSV</button>}
          <button className={cx("btn-subtle btn-xs", sideOpen && "text-text bg-surface-3")} aria-pressed={sideOpen} onClick={() => setSideOpen(!sideOpen)} title="Toggle saved queries and history">{Icon.activity({ size: 12 })} Saved & history</button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-bg">
          {plan ? (plan.ok ? <pre className="p-4 font-mono text-[12.5px] leading-[1.7] text-text-2 whitespace-pre">{plan.plan?.join("\n")}</pre> : <div className="p-4 text-[12.5px] text-red-soft">{plan.reason || plan.error}</div>)
            : !res ? <EmptyState compact icon={Icon.play()} title="Results show here" hint="Write a SELECT above (tables and columns complete as you type), then press Run." />
            : res.ok ? (res.rows?.length ? <ResultsTable columns={res.columns || []} rows={res.rows} masked={res.masked || []} hidden={res.hidden || []} /> : <EmptyState compact icon={Icon.table()} title="No rows" hint="The query ran but returned nothing." />)
            : <div className="p-4 flex flex-col gap-2"><div className={cx("text-[12.5px]", res.blocked ? "text-amber" : "text-red-soft")}>{res.blocked ? "Blocked by the read guard" : "Query failed"}</div><pre className="text-[12px] text-text-2 whitespace-pre-wrap font-mono bg-bg-deep border border-border rounded-[6px] p-3">{res.reason || res.error || "unknown error"}</pre></div>}
        </div>
        <div className="flex-none flex items-center gap-3 px-3 h-8 border-t border-border bg-surface text-[12px] text-muted">
          {plan ? <><span>Query plan</span>{plan.ok && <span className="text-dim">{plan.engine} · {plan.ms} ms</span>}</>
            : res?.ok ? <>
              <span><b className="text-text">{fmtNum(res.rowCount)}</b> row{res.rowCount === 1 ? "" : "s"}</span><span className="text-dim">{res.ms} ms</span>
              {(!!res.hidden?.length || !!res.masked?.length) && <LockChip kind={res.hidden?.length ? "hidden" : "masked"} count={(res.hidden?.length || 0) + (res.masked?.length || 0)} />}
              {res.truncated && <span className="text-amber">truncated at {res.limit} rows</span>}
            </> : res ? <span className="text-red-soft">{res.blocked ? "Blocked by the read guard" : "Error"}</span> : <span className="text-dim">Ready</span>}
          <div className="flex-1" />
          {res?.ok && !!res.rows?.length && <button className="btn-subtle btn-xs" onClick={copyJson}>{Icon.copy({ size: 12 })} Copy as JSON</button>}
        </div>
      </div>

      {sideOpen && <QuerySide saved={saved} history={history} loading={lists.loading} env={env} width={side.size} handle={side.handle}
        onLoad={load} onRun={(q) => { load(q); void run(q.sql); }} onAct={act} onName={(q) => { setNaming(q); setName(q.name || q.question || ""); }} />}

      <Modal open={!!naming} onClose={() => setNaming(null)} title={naming?.saved ? "Rename query" : "Save query"} width={440} footer={<><button className="btn-ghost" onClick={() => setNaming(null)}>Cancel</button><button className="btn-primary" onClick={saveName}>Save</button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Active users this week" onKeyDown={(e) => { if (e.key === "Enter") saveName(); }} /></Field>
          <pre className="bg-bg-deep border border-border rounded-[6px] p-3 text-[12px] text-text-2 font-mono whitespace-pre-wrap max-h-[160px] overflow-auto">{naming?.sql}</pre>
        </div>
      </Modal>
    </div>
  );
}
