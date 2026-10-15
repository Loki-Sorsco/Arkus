"use client";
// A table open in the editor: toolbar (name · engine · Data | Structure · pending count · Refresh · Sync)
// over the data grid (staged edits, FK cells jump to the referenced table tab) or the column / index
// structure with a generated CREATE TABLE. Structure is where the schema is edited by hand: add / rename /
// change / drop columns, add / drop indexes, rename / drop the table — every dialog previews the exact SQL
// and applies it through /db/schema/change (prod behind the gate). Secret columns are flagged and never
// read, written or altered. Staged grid edits mark the tab dirty so closing it asks first.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { Chip, EmptyState, Icon, Tabs } from "@/components/ui";
import { cx, timeAgo } from "@/lib/ui";
import { DataGrid } from "@/components/screens/db-grid";
import { buildDdl } from "@/components/screens/db-ddl";
import { SqlEditor } from "@/components/screens/db-sql-editor";
import { DropTableModal, RenameTableModal } from "@/components/screens/schema-modals";
import { AddColumnDdlModal, AddIndexModal, ChangeColumnModal, DropColumnModal, DropIndexModal, RenameColumnModal, SQLITE_ALTER } from "@/components/screens/schema-column-modals";
import { engineLabel, useDbSchema, type DbColumn, type DbTable, type Filter, type PublicSource } from "@/components/screens/db-shared";
import { CenteredSpinner, ConnectEmpty, LockedEmpty, SyncButton, tableName, tableTab, useDbSync, useSchemaChanges } from "./db-common";

type View = "data" | "structure";
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

export function TableTab({ tab }: { tab: Tab }) {
  const { openTab, updateTab } = useWorkspace();
  const schema = useDbSchema();
  const { tables, engine, source, schemaOnly, snapshot, loading, reload } = schema;
  useSchemaChanges(reload);
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
        : <Structure table={table} tables={tables} engine={engine} highlight={column} canWrite={canRead} />}
    </div>
  );
}

function MissingTable({ name, source, reload }: { name: string; source: PublicSource | null; reload: () => Promise<void> }) {
  const hasSource = !!source;
  const { syncing, sync } = useDbSync(source, reload);
  return <EmptyState icon={Icon.table()} title="This table is not in the current schema" hint={<>No table named <span className="font-mono text-text">{name}</span> on this env. {hasSource ? "It may have been renamed or dropped; sync to re-introspect." : "Switch env or connect a database that has it."}</>}
    action={hasSource ? <button className="btn-ghost btn-sm" disabled={syncing} onClick={sync}>{Icon.refresh({ size: 13 })} Sync schema</button> : undefined} />;
}

type Dialog =
  | { kind: "add" | "index" | "renameTable" | "dropTable" }
  | { kind: "rename" | "change" | "drop"; column: DbColumn }
  | { kind: "dropIndex"; index: DbTable["indexes"][number] };

/** ⋯ menu with the table-level changes (rename, drop). */
function TableMenu({ onPick }: { onPick: (k: "renameTable" | "dropTable") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; window.addEventListener("mousedown", h); return () => window.removeEventListener("mousedown", h); }, [open]);
  const pick = (k: "renameTable" | "dropTable") => { setOpen(false); onPick(k); };
  return (
    <div ref={ref} className="relative dev-only">
      <button className={cx("btn-subtle btn-xs", open && "text-text bg-surface-3")} title="Table actions" aria-label="Table actions" aria-expanded={open} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div className="absolute right-0 top-7 w-[180px] card py-1 shadow-[0_12px_32px_rgba(0,0,0,.35)] z-30 arise text-[12.5px]">
          <div className="px-3 h-8 flex items-center hover:bg-surface-3 cursor-pointer" onClick={() => pick("renameTable")}>Rename table</div>
          <div className="px-3 h-8 flex items-center gap-1.5 hover:bg-surface-3 cursor-pointer text-red-soft" onClick={() => pick("dropTable")}>{Icon.trash({ size: 12 })} Drop table</div>
        </div>
      )}
    </div>
  );
}

function Structure({ table, tables, engine, highlight, canWrite }: { table: DbTable; tables: DbTable[]; engine: string | null; highlight?: string; canWrite: boolean }) {
  const { openTab } = useWorkspace();
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const [ddl, setDdl] = useState(false);
  const close = () => setDlg(null);
  const indexed = (c: string) => table.indexes.some((i) => i.columns.includes(c));
  const ddlText = useMemo(() => (ddl ? buildDdl(table, engine) : ""), [ddl, table, engine]);
  const sqlite = engine === "sqlite";
  // Scroll the highlighted column into view when the tab opens on it.
  useEffect(() => { if (highlight) document.getElementById(`col-${table.name}-${highlight}`)?.scrollIntoView({ block: "center" }); }, [highlight, table.name]);
  const base = { open: true, onClose: close, table, engine };
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-bg">
      <div className="max-w-[960px] px-6 py-4 flex flex-col gap-5">
        <section>
          <div className="flex items-center gap-2 h-8 mb-1">
            <span className="eyebrow">Columns</span><span className="text-[11px] text-dim tabular-nums">{table.columns.length}</span>
            <span className="flex-1" />
            <button className={cx("btn-subtle btn-xs", ddl && "text-text bg-surface-3")} aria-pressed={ddl} onClick={() => setDdl((d) => !d)} title="Show the CREATE TABLE this schema describes (generated, read-only)">{"</>"} DDL</button>
            {canWrite && <button className="btn-subtle btn-xs dev-only" onClick={() => setDlg({ kind: "add" })}>{Icon.plus({ size: 12 })} Add column</button>}
            {canWrite && <TableMenu onPick={(kind) => setDlg({ kind })} />}
          </div>
          {ddl ? (
            <div className="card overflow-hidden" style={{ height: Math.min(520, ddlText.split("\n").length * 20 + 14) }}>
              <SqlEditor value={ddlText} engine={engine} tables={[]} readOnly />
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="tbl hover">
                <thead><tr><th>Name</th><th>Type</th><th>Keys</th><th>Constraints</th>{canWrite && <th className="w-[200px]" />}</tr></thead>
                <tbody>
                  {table.columns.map((c) => (
                    <tr key={c.name} id={`col-${table.name}-${c.name}`} className={cx("group", highlight === c.name && "bg-accent/10")}>
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
                      {canWrite && (
                        <td className="whitespace-nowrap text-right py-1">
                          {!c.secret && (
                            <span className="inline-flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 dev-only">
                              <button className="btn-subtle btn-xs" onClick={() => setDlg({ kind: "rename", column: c })}>Rename</button>
                              <span title={sqlite ? SQLITE_ALTER : c.pk ? "Primary keys are not changed from here." : "Change the type, nullability or default"}><button className="btn-subtle btn-xs" disabled={sqlite || c.pk} onClick={() => setDlg({ kind: "change", column: c })}>Change</button></span>
                              <span title={c.pk ? "Primary keys cannot be dropped." : "Drop this column"}><button className="btn-subtle btn-xs text-red-soft hover:text-red-soft" disabled={c.pk} onClick={() => setDlg({ kind: "drop", column: c })}>Drop</button></span>
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {!table.columns.length && <tr><td colSpan={canWrite ? 5 : 4} className="text-dim text-[12.5px]">Columns unknown. Sync the schema or index the code.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section>
          <div className="flex items-center gap-2 h-8 mb-1">
            <span className="eyebrow">Indexes</span><span className="text-[11px] text-dim tabular-nums">{table.indexes.length}</span>
            <span className="flex-1" />
            {canWrite && <button className="btn-subtle btn-xs dev-only" onClick={() => setDlg({ kind: "index" })}>{Icon.plus({ size: 12 })} Add index</button>}
          </div>
          {table.indexes.length ? (
            <div className="card overflow-hidden">
              <table className="tbl hover">
                <thead><tr><th>Name</th><th>Columns</th><th>Kind</th>{canWrite && <th className="w-[80px]" />}</tr></thead>
                <tbody>{table.indexes.map((i, k) => (
                  <tr key={i.name || k} className="group">
                    <td className="font-mono text-[12.5px] text-text-2">{i.name || <span className="text-dim">unnamed</span>}</td>
                    <td className="font-mono text-[12.5px]">{i.columns.join(", ")}</td>
                    <td>{i.unique ? <Chip tone="muted">unique</Chip> : <span className="text-[12px] text-dim">index</span>}</td>
                    {canWrite && <td className="text-right py-1">{i.name && !/^(sqlite_autoindex|primary$)/i.test(i.name) && !i.name.endsWith("_pkey") && <button className="btn-subtle btn-xs text-red-soft hover:text-red-soft opacity-0 group-hover:opacity-100 focus:opacity-100 dev-only" onClick={() => setDlg({ kind: "dropIndex", index: i })}>Drop</button>}</td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className="text-[12.5px] text-dim">No indexes besides the primary key.</div>}
        </section>
      </div>
      {dlg?.kind === "add" && <AddColumnDdlModal {...base} tables={tables} />}
      {dlg?.kind === "rename" && <RenameColumnModal {...base} column={dlg.column} />}
      {dlg?.kind === "change" && <ChangeColumnModal {...base} column={dlg.column} />}
      {dlg?.kind === "drop" && <DropColumnModal {...base} column={dlg.column} />}
      {dlg?.kind === "index" && <AddIndexModal {...base} />}
      {dlg?.kind === "dropIndex" && <DropIndexModal {...base} index={dlg.index} />}
      {dlg?.kind === "renameTable" && <RenameTableModal open onClose={close} table={table.name} engine={engine} />}
      {dlg?.kind === "dropTable" && <DropTableModal open onClose={close} table={table.name} engine={engine} />}
    </div>
  );
}
