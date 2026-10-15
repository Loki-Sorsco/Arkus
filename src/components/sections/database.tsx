"use client";
// Database: tables on the left, the chosen table (Data · Structure) on the right. Query (SQL or
// English), Diagram and the rest live behind two buttons so the screen stays calm.
import { useEffect, useRef, useState } from "react";
import { ConnectDbModal } from "@/components/screens/db-connect";
import { useDbSchema, type DbColumn } from "@/components/screens/db-shared";
import { PanelSection, TreeRow } from "@/components/shell/side-panel";
import { ListPane, useWorkspace } from "@/components/shell/workspace";
import { TableTab } from "@/components/tabs/table-tab";
import { QueryTab } from "@/components/tabs/query-tab";
import { SchemaTab } from "@/components/tabs/schema-tab";
import { HistoryTab } from "@/components/tabs/history-tab";
import { DriftTab } from "@/components/tabs/drift-tab";
import { useDbSync } from "@/components/tabs/db-common";
import { Chip, EmptyState, Icon, SearchInput, Spinner } from "@/components/ui";
import { cx } from "@/lib/ui";
import { Explainer } from "@/components/shell/explainer";

const Mark = ({ c }: { c: DbColumn }) => <span className="w-3 flex-none text-center text-[10px] leading-none">{c.pk ? <span className="text-gold" title="primary key">●</span> : c.references ? <span className="text-teal" title={`references ${c.references.table}.${c.references.column}`}>◆</span> : c.secret ? <span className="text-dim" title="secret, never shown">{Icon.lock({ size: 10 })}</span> : null}</span>;

export function DatabaseSection() {
  const { params, go, env, project } = useWorkspace();
  const schema = useDbSchema();
  const sel = params.get("sel");
  const view = params.get("view") || (sel ? "table" : "");
  const column = params.get("column") || "";
  const noDb = !schema.fromDb;
  const [connect, setConnect] = useState(false);
  // First visit: open the first table.
  useEffect(() => { if (!view && schema.tables.length) go("database", { view: "table", sel: `table:${schema.tables[0].name}` }, { replace: true }); }, [view, schema.tables, go]);
  const table = view === "table" && sel ? schema.tables.find((t) => `table:${t.name}` === sel) : null;
  return (
    <div className="flex-1 min-h-0 flex">
      <ListPane width={264}><TableList view={view} sel={sel} onConnect={() => setConnect(true)} /></ListPane>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <Explainer id="database" />
        {view === "table" && sel && (schema.loading && !schema.tables.length ? <div className="flex-1 flex items-center justify-center"><Spinner /></div>
          : <TableTab key={sel} tab={{ id: `table:${sel}`, kind: "table", key: sel, label: table?.name || sel.replace(/^table:/, ""), params: { column, filters: params.get("filters") || "" } }} />)}
        {view === "query" && <QueryTab key={params.get("id") || "q1"} tab={{ id: "query", kind: "query", key: params.get("id") || "q1", label: "Query", params: { sql: params.get("sql") || "" } }} />}
        {view === "diagram" && <SchemaTab tab={{ id: "schema", kind: "schema", key: sel || undefined, label: "Schema" }} />}
        {view === "history" && <HistoryTab tab={{ id: "history", kind: "history", label: "History" }} />}
        {view === "drift" && <DriftTab tab={{ id: "drift", kind: "drift", label: "Drift" }} />}
        {!view && !schema.loading && (noDb
          ? <EmptyState icon={Icon.db()} title={`No ${env} database connected`} hint="Connect it to browse and edit rows. Tables found in the code still show on the left." action={<button className="btn-primary" onClick={() => setConnect(true)}>Connect database</button>} />
          : <EmptyState icon={Icon.table()} title="Pick a table" hint="Choose a table on the left, or open the query console." />)}
      </div>
      <ConnectDbModal open={connect} onClose={() => setConnect(false)} env={env} existing={schema.source} onConnected={async () => { await schema.reload(); }} />
      <span className="hidden">{project.slug}</span>
    </div>
  );
}

function TableList({ view, sel, onConnect }: { view: string; sel: string | null; onConnect: () => void }) {
  const { go, env } = useWorkspace();
  const { tables, source, schemaOnly, loading, reload } = useDbSchema();
  const sync = useDbSync(source, reload);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!more) return; const h = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMore(false); }; window.addEventListener("mousedown", h); return () => window.removeEventListener("mousedown", h); }, [more]);
  const needle = q.trim().toLowerCase();
  const list = tables.filter((t) => t.name.toLowerCase().includes(needle) || (needle.length > 1 && t.columns.some((c) => c.name.toLowerCase().includes(needle))));
  const activeCol = view === "table" ? (new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("column") || "") : "";
  const tool = (v: string, label: string, icon: React.ReactNode) => <button className={cx("btn-xs flex-1", view === v ? "btn-primary" : "btn-ghost")} onClick={() => go("database", { view: v, ...(v === "query" ? { id: `q${Date.now().toString(36)}` } : {}) })}>{icon} {label}</button>;
  return (
    <>
      <div className="px-2 pt-2 pb-1.5 flex-none"><SearchInput value={q} onChange={setQ} placeholder="Filter tables" /></div>
      <PanelSection title="Tables" count={tables.length} open onToggle={() => {}} grow>
        {loading && !tables.length && <div className="px-3 py-2"><Spinner /></div>}
        {!loading && !tables.length && <div className="px-3 py-2 text-[12px] text-dim prose">No tables yet. Connect a database or analyse the code.</div>}
        {list.map((t) => {
          const isOpen = open[t.name] ?? (needle.length > 1 && !t.name.toLowerCase().includes(needle));
          const active = view === "table" && sel === `table:${t.name}`;
          return (
            <div key={t.name}>
              <TreeRow name={t.name} chevron={isOpen ? "open" : "closed"} active={active && !activeCol} meta={`${t.columns.length}`} title={`${t.name} · ${t.columns.length} columns`}
                onClick={() => go("database", { view: "table", sel: `table:${t.name}` })} icon={<button className="w-3.5 h-3.5 -ml-5 flex items-center justify-center text-dim hover:text-text cursor-pointer" onClick={(e) => { e.stopPropagation(); setOpen((m) => ({ ...m, [t.name]: !isOpen })); }} aria-label="Expand">{Icon.chevron({ size: 11, className: isOpen ? "rotate-90" : "" })}</button>} />
              {isOpen && t.columns.map((c) => <TreeRow key={c.name} depth={1} chevron={null} name={c.name} dot={<Mark c={c} />} meta={<span className="font-mono">{c.type || ""}</span>} active={active && activeCol === c.name} onClick={() => go("database", { view: "table", sel: `table:${t.name}`, column: c.name })} />)}
            </div>
          );
        })}
      </PanelSection>
      <div className="flex-none border-t border-border p-2 flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          {tool("query", "Query", Icon.bolt({ size: 12 }))}
          {tool("diagram", "Diagram", Icon.layers({ size: 12 }))}
          <div ref={moreRef} className="relative">
            <button className={cx("btn-xs btn-ghost", (view === "history" || view === "drift") && "text-text")} onClick={() => setMore((o) => !o)} title="More">⋯</button>
            {more && (
              <div className="absolute right-0 bottom-8 w-[200px] card py-1 shadow-[0_12px_32px_rgba(0,0,0,.55)] z-30 arise text-[12.5px]">
                <div className="px-3 h-8 flex items-center hover:bg-surface-3 cursor-pointer" onClick={() => { setMore(false); go("database", { view: "history" }); }}>Schema history</div>
                <div className="px-3 h-8 flex items-center hover:bg-surface-3 cursor-pointer" onClick={() => { setMore(false); go("database", { view: "drift" }); }}>Drift (code vs database)</div>
                {source && <div className="px-3 h-8 flex items-center hover:bg-surface-3 cursor-pointer" onClick={() => { setMore(false); sync.sync(); }}>{sync.syncing ? <Spinner /> : "Sync schema"}</div>}
                <div className="px-3 h-8 flex items-center hover:bg-surface-3 cursor-pointer" onClick={() => { setMore(false); onConnect(); }}>{source ? "Change database" : "Connect database"}</div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-dim min-w-0">
          <Chip tone={env === "prod" ? "red" : env === "preview" ? "amber" : "muted"} className="capitalize">{env}</Chip>
          <span className="font-mono truncate" title={source?.display}>{source ? source.database || source.display : tables.length ? "from code" : "no database"}</span>
          {schemaOnly && <span title="schema only">{Icon.lock({ size: 11 })}</span>}
        </div>
      </div>
    </>
  );
}
