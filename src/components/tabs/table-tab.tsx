"use client";
// A table open in the editor: toolbar (name · engine · Data | Structure · pending count · Refresh · Sync)
// over the data grid (staged edits, FK cells jump to the referenced table tab) or the column / index
// structure with a generated CREATE TABLE (Add column drafts a plan change). Secret columns are flagged
// and never read or written. Staged grid edits mark the tab dirty so closing it asks first.
import { useCallback, useEffect, useMemo, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { Chip, EmptyState, Icon, Tabs } from "@/components/ui";
import { cx, timeAgo } from "@/lib/ui";
import { DataGrid } from "@/components/screens/db-grid";
import { buildDdl } from "@/components/screens/db-ddl";
import { SqlEditor } from "@/components/screens/db-sql-editor";
import { AddColumnModal } from "@/components/screens/inspector";
import { engineLabel, useDbSchema, type DbTable, type Filter, type PublicSource } from "@/components/screens/db-shared";
import { CenteredSpinner, ConnectEmpty, LockedEmpty, SyncButton, tableName, tableTab, useDbSync } from "./db-common";

type View = "data" | "structure";
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

export function TableTab({ tab }: { tab: Tab }) {
  const { openTab, updateTab } = useWorkspace();
  const schema = useDbSchema();
  const { tables, engine, source, schemaOnly, snapshot, loading, reload } = schema;
  const name = tableName(tab.key) || tab.label;
  const table = tables.find((t) => t.name === name) || null;
  const [picked, setPicked] = useState<View | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const canRead = !!source && !schemaOnly;
  const view: View = picked ?? (canRead ? "data" : "structure");
  const filtersParam = tab.params?.filters;
  const column = tab.params?.column;
  // A column deep link (side panel, graph) lands on Structure with that column highlighted.
  useEffect(() => { if (column) setPicked("structure"); }, [column]);
  // `n` must change whenever the params change (DataGrid re-applies the filters on it); a hash of the
  // params string does that deterministically.
  const jump = useMemo(() => {
    if (!filtersParam) return null;
    try { return { table: name, filters: JSON.parse(filtersParam) as Filter[], n: hash(`${name}|${filtersParam}`) }; } catch { return null; }
  }, [filtersParam, name]);
  const onJump = (t: string, filters: Filter[]) => openTab({ ...tableTab(t), params: { filters: JSON.stringify(filters) } });
  const onPendingChange = useCallback((n: number) => { setPendingCount(n); updateTab(tab.id, { dirty: n > 0 }); }, [tab.id, updateTab]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title={<><span className="font-mono">{name}</span>{engine && <Chip title={source ? source.display : "engine from code"}>{engineLabel(engine)}</Chip>}</>} meta={snapshot ? `introspected ${timeAgo(snapshot.createdAt)}` : "schema from code"}
        right={<>
          {pendingCount > 0 && <Chip tone="amber" title="Staged changes in the data grid; apply or discard them from the bar below the grid">{pendingCount} pending</Chip>}
          {view === "data" && canRead && <button className="btn-icon btn-xs" title="Refresh rows" aria-label="Refresh rows" onClick={() => setRefreshKey((k) => k + 1)}>{Icon.refresh({ size: 13 })}</button>}
          <SyncButton source={source} reload={reload} />
        </>}>
        <Tabs size="sm" value={view} onChange={setPicked} items={[{ id: "data", label: "Data" }, { id: "structure", label: "Structure", count: table?.columns.length }]} />
      </TabToolbar>
      {loading && !tables.length ? <CenteredSpinner />
        : !table ? <MissingTable name={name} source={source} reload={reload} />
        : view === "data" ? (
          !source ? <ConnectEmpty title={`No database connected on this env`} hint="The table comes from the code analysis; connect a database to browse its rows." onConnected={reload} />
          : schemaOnly ? <LockedEmpty />
          : <DataGrid table={table} tables={tables} engine={engine} jump={jump} onJump={onJump} refreshKey={refreshKey} onPendingChange={onPendingChange} />
        )
        : <Structure table={table} engine={engine} highlight={column} />}
    </div>
  );
}

function MissingTable({ name, source, reload }: { name: string; source: PublicSource | null; reload: () => Promise<void> }) {
  const hasSource = !!source;
  const { syncing, sync } = useDbSync(source, reload);
  return <EmptyState icon={Icon.table()} title="This table is not in the current schema" hint={<>No table named <span className="font-mono text-text">{name}</span> on this env. {hasSource ? "It may have been renamed or dropped; sync to re-introspect." : "Switch env or connect a database that has it."}</>}
    action={hasSource ? <button className="btn-ghost btn-sm" disabled={syncing} onClick={sync}>{Icon.refresh({ size: 13 })} Sync schema</button> : undefined} />;
}

function Structure({ table, engine, highlight }: { table: DbTable; engine: string | null; highlight?: string }) {
  const { addDraft, openTab } = useWorkspace();
  const [addOpen, setAddOpen] = useState(false);
  const [ddl, setDdl] = useState(false);
  const indexed = (c: string) => table.indexes.some((i) => i.columns.includes(c));
  const ddlText = useMemo(() => (ddl ? buildDdl(table, engine) : ""), [ddl, table, engine]);
  // Scroll the highlighted column into view when the tab opens on it.
  useEffect(() => { if (highlight) document.getElementById(`col-${table.name}-${highlight}`)?.scrollIntoView({ block: "center" }); }, [highlight, table.name]);
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-bg">
      <div className="max-w-[960px] px-6 py-4 flex flex-col gap-5">
        <section>
          <div className="flex items-center gap-2 h-8 mb-1">
            <span className="eyebrow">Columns</span><span className="text-[11px] text-dim tabular-nums">{table.columns.length}</span>
            <span className="flex-1" />
            <button className={cx("btn-subtle btn-xs", ddl && "text-text bg-surface-3")} aria-pressed={ddl} onClick={() => setDdl((d) => !d)} title="Show the CREATE TABLE this schema describes (generated, read-only)">{"</>"} DDL</button>
            <button className="btn-subtle btn-xs dev-only" onClick={() => setAddOpen(true)}>{Icon.plus({ size: 12 })} Add column</button>
          </div>
          {ddl ? (
            <div className="card overflow-hidden" style={{ height: Math.min(520, ddlText.split("\n").length * 20 + 14) }}>
              <SqlEditor value={ddlText} engine={engine} tables={[]} readOnly />
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="tbl hover">
                <thead><tr><th>Name</th><th>Type</th><th>Keys</th><th>Constraints</th></tr></thead>
                <tbody>
                  {table.columns.map((c) => (
                    <tr key={c.name} id={`col-${table.name}-${c.name}`} className={cx(highlight === c.name && "bg-accent/10")}>
                      <td className="font-mono text-[12.5px] whitespace-nowrap"><span className="inline-flex items-center gap-1.5">{c.name}{c.secret && <span className="text-red-soft" title="Secret-like column: never read, never written.">{Icon.lock({ size: 11 })}</span>}{c.pii && !c.secret && <span className="text-amber" title="Personal data: masked before it leaves the database.">{Icon.lock({ size: 11 })}</span>}</span></td>
                      <td className="font-mono text-[12px] text-dim whitespace-nowrap">{c.type || "unknown"}</td>
                      <td className="whitespace-nowrap"><span className="inline-flex gap-1">
                        {c.pk && <Chip tone="gold">PK</Chip>}
                        {c.references && <Chip tone="teal" className="cursor-pointer font-mono" title={`Open ${c.references.table}`} onClick={() => openTab(tableTab(c.references!.table), { preview: true })}>FK {"->"} {c.references.table}.{c.references.column}</Chip>}
                        {c.unique && <Chip>unique</Chip>}
                        {!c.unique && !c.pk && (c.index || indexed(c.name)) && <Chip>indexed</Chip>}
                      </span></td>
                      <td className="text-[12px] text-text-2 whitespace-nowrap"><span className="inline-flex gap-2 items-center">
                        <span className={c.nullable ? "text-dim" : ""}>{c.nullable ? "nullable" : "not null"}</span>
                        {c.default != null && c.default !== "" && <span className="font-mono text-dim" title="default">default {c.default}</span>}
                      </span></td>
                    </tr>
                  ))}
                  {!table.columns.length && <tr><td colSpan={4} className="text-dim text-[12.5px]">Columns unknown. Sync the schema or index the code.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section>
          <div className="flex items-center gap-2 h-8 mb-1"><span className="eyebrow">Indexes</span><span className="text-[11px] text-dim tabular-nums">{table.indexes.length}</span></div>
          {table.indexes.length ? (
            <div className="card overflow-hidden">
              <table className="tbl hover">
                <thead><tr><th>Name</th><th>Columns</th><th>Kind</th></tr></thead>
                <tbody>{table.indexes.map((i, k) => (
                  <tr key={i.name || k}><td className="font-mono text-[12.5px] text-text-2">{i.name || <span className="text-dim">unnamed</span>}</td><td className="font-mono text-[12.5px]">{i.columns.join(", ")}</td><td>{i.unique ? <Chip tone="muted">unique</Chip> : <span className="text-[12px] text-dim">index</span>}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className="text-[12.5px] text-dim">No indexes besides the primary key.</div>}
        </section>
      </div>
      <AddColumnModal open={addOpen} onClose={() => setAddOpen(false)} table={table.name} existing={table.columns.map((c) => c.name)}
        onAdd={(d) => { addDraft({ label: `add ${table.name}.${d.column}`, intent: { kind: "add_column", table: table.name, column: d.column, type: d.type, nullable: d.nullable } }); setAddOpen(false); }} />
    </div>
  );
}
