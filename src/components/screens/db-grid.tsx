"use client";
// Data tab: paged, sortable, filterable grid over GET db/rows. Toolbar (filters · columns · export · edit),
// sticky header, lock marks on masked / withheld columns, FK cells jump to the referenced row.
// Edit mode stages changes instead of writing them (Beekeeper model): cell edits turn amber, deleted rows
// turn red, "Add row" puts an editable green row on top. Nothing reaches the database until Apply, which
// runs the staged mutations in order through POST db/mutate (parameterized, pk-targeted, guarded by the
// original values) behind the prod gate and stops at the first failure. Pending edits live in db-pending.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, EmptyState, Icon, Spinner, useToast } from "@/components/ui";
import { cx, fmtNum, useApi } from "@/lib/ui";
import { dbBase, exportRows, fmtCell, isSecretName, LockChip, OPS, opLabel, post, ResultsTable, type DbTable, type Filter, type FilterOp, type Row } from "./db-shared";
import { addInsert, applyStaged, buildMutations, emptyPending, insertProblems, isAutoKey, isDeleted, overlayByPk, pendingCount, pendingStore, pkKey, rawText, removeInsert, removeStaged, same, setInsertValue, stageUpdate, toggleDelete, updateKey, type Mutation, type MutateResp, type Pending } from "./db-pending";
import { CellEditor, ChangesBar, InsertRow, PencilIcon } from "./db-grid-parts";
export { TablesRail } from "./db-grid-parts";

type RowsResp = { table: string; columns: string[]; hidden: string[]; masked: string[]; rows: Row[]; page: number; pageSize: number; total: number; totalExact: boolean; ms: number };
type Cell = { row: number; col: string };
const PAGE = 50;

export function DataGrid({ table, tables, engine, jump, onJump, refreshKey, onPendingChange }: { table: DbTable; tables: DbTable[]; engine: string | null; jump: { table: string; filters: Filter[]; n: number } | null; onJump: (table: string, filters: Filter[]) => void; refreshKey?: number; onPendingChange?: (n: number) => void }) {
  const { project, env, gate } = useWorkspace();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Filter[]>(jump && jump.table === table.name ? jump.filters : []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Filter>({ column: table.columns[0]?.name || "", op: "=", value: "" });
  // edit mode + staged changes (kept in a module store so they survive the tab being unmounted)
  const storeKey = pendingStore.key(project.slug, env, table.name);
  const [pending, setPendingRaw] = useState<Pending>(() => pendingStore.get(storeKey));
  const setPending = useCallback((fn: (p: Pending) => Pending) => setPendingRaw((p) => { const n = fn(p); pendingStore.set(storeKey, n); return n; }), [storeKey]);
  const count = pendingCount(pending);
  const [editing, setEditing] = useState(count > 0);
  const [cell, setCell] = useState<Cell | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => { onPendingChange?.(count); }, [count, onPendingChange]);
  // reset when the table changes; a jump arrives with its own filters
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); setSort(null); setFilters(jump && jump.table === table.name ? jump.filters : []); setAdding(false); setDraft({ column: table.columns[0]?.name || "", op: "=", value: "" }); setCell(null); setShowSql(false); const p = pendingStore.get(storeKey); setPendingRaw(p); if (pendingCount(p)) setEditing(true); }, [storeKey, jump?.n]);

  const qs = new URLSearchParams({ env, table: table.name, page: String(page), pageSize: String(PAGE) });
  if (sort) { qs.set("sort", sort.column); qs.set("dir", sort.dir); }
  if (filters.length) qs.set("filters", JSON.stringify(filters.map((f) => ({ column: f.column, op: f.op, ...(OPS.find((o) => o.op === f.op)?.needsValue ? { value: f.value } : {}) }))));
  const base = dbBase(project.slug);
  const r = useApi<RowsResp>(`${base}/rows?${qs.toString()}`);
  useEffect(() => { if (refreshKey) r.reload(true); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const colMeta = useMemo(() => Object.fromEntries(table.columns.map((c) => [c.name, c])), [table]);
  const keyCol = table.columns.find((c) => c.pk) || table.columns.find((c) => c.unique);
  const pages = r.data ? Math.max(1, Math.ceil(r.data.total / PAGE)) : 1;
  const canEdit = !!keyCol && !!r.data && !r.error;
  const rows = useMemo(() => r.data?.rows ?? [], [r.data]);
  const allCols = useMemo(() => [...(r.data?.columns ?? []), ...(r.data?.hidden ?? [])], [r.data]);
  const pkOf = (rowIdx: number) => (keyCol ? rows[rowIdx]?.[keyCol.name] : undefined);
  // rows as the grid shows them: fetched values with staged edits laid over
  const viewRows = useMemo(() => {
    if (!keyCol) return rows;
    const by = overlayByPk(pending);
    return rows.map((row) => { const o = by[pkKey(row[keyCol.name])]; return o ? { ...row, ...o } : row; });
  }, [rows, pending, keyCol]);
  const staged = useMemo(() => (keyCol ? buildMutations(pending, table.name, keyCol.name) : []), [pending, table.name, keyCol]);
  const problems = useMemo(() => insertProblems(pending, table.columns, isSecretName), [pending, table.columns]);

  /** Page / sort / filter changes reload the rows; with staged edits that would silently drop them, so ask first. */
  const guarded = (fn: () => void) => {
    if (count && !window.confirm(`Discard ${count} pending change${count === 1 ? "" : "s"} to ${table.name}?`)) return;
    if (count) { setPending(() => emptyPending()); setShowSql(false); }
    setCell(null); fn();
  };
  const onSort = (c: string) => guarded(() => { setPage(1); setSort((s) => (s?.column === c ? (s.dir === "asc" ? { column: c, dir: "desc" } : null) : { column: c, dir: "asc" })); });
  const addFilter = () => { if (!draft.column) return; guarded(() => { setFilters((f) => [...f, draft]); setPage(1); setAdding(false); setDraft({ column: draft.column, op: "=", value: "" }); }); };

  // ---------- staging ----------
  const editable = (col: string) => editing && !!keyCol && col !== keyCol.name && !r.data?.masked.includes(col) && !r.data?.hidden.includes(col) && !colMeta[col]?.secret && !isSecretName(col);
  const lockReason = (col: string) => (keyCol && col === keyCol.name ? "Primary key: not edited in place" : r.data?.masked.includes(col) ? "Masked column: you only see part of the value, so it can't be edited here" : colMeta[col]?.secret || isSecretName(col) ? "Secret column: never written by Arkus" : undefined);
  const stage = (rowIdx: number, col: string, next: unknown) => {
    setCell(null);
    const row = rows[rowIdx]; if (!row || !keyCol) return;
    setPending((p) => stageUpdate(p, row[keyCol.name], col, row[col], next));
  };
  const addRow = () => {
    setCell(null); setEditing(true);
    // A text key with no database default (cuid / uuid handed out by the app) starts from a fresh uuid.
    const seed: Record<string, string> = {};
    if (keyCol && !isAutoKey(keyCol) && /char|text|string|uuid/i.test(keyCol.type || "") && typeof crypto !== "undefined" && "randomUUID" in crypto) seed[keyCol.name] = crypto.randomUUID();
    setPending((p) => addInsert(p, Math.random().toString(36).slice(2, 9), seed));
  };
  const discard = () => { if (!count || !window.confirm(`Discard ${count} pending change${count === 1 ? "" : "s"}?`)) return; setPending(() => emptyPending()); setShowSql(false); setCell(null); };

  const mutate = useCallback((m: Mutation) => post<MutateResp>(`${base}/mutate`, { env, mutation: m }), [base, env]);
  const apply = () => {
    if (!staged.length || applying || problems.length) return;
    setCell(null);
    gate(async () => {
      setApplying(true);
      try {
        const res = await applyStaged(staged, mutate, engine);
        setPending((p) => removeStaged(p, res.applied));
        if (res.failed) toast({ title: `Stopped at change ${res.failed.index + 1} of ${staged.length}${res.done ? ` · ${res.done} applied` : ""}`, detail: `${res.failed.error} · ${res.failed.sql}`, kind: "error" });
        else { toast({ title: `Applied ${staged.length} change${staged.length === 1 ? "" : "s"} to ${table.name}`, detail: `${env} · ${staged.map((s) => s.mutation.op).join(", ")}`, kind: "ok" }); setShowSql(false); }
        await r.reload(true);
      } finally { setApplying(false); }
    });
  };

  // Tab / Shift+Tab walk the editable cells row by row.
  const moveCell = (from: Cell, dir: 1 | -1) => {
    const cols = (r.data?.columns || []).filter(editable);
    const ci = cols.indexOf(from.col);
    let row = from.row, idx = ci + dir;
    if (idx >= cols.length) { row += 1; idx = 0; } else if (idx < 0) { row -= 1; idx = cols.length - 1; }
    if (row < 0 || row >= rows.length || !cols.length) { setCell(null); return; }
    setCell({ row, col: cols[idx] });
  };
  const onCellClick = (col: string, _row: Row, rowIdx: number) => {
    if (!editing) return;
    if (isDeleted(pending, pkOf(rowIdx))) { toast({ title: "Row marked for deletion", detail: "Restore it from the trash icon to edit it.", kind: "warn" }); return; }
    if (!editable(col)) { const why = lockReason(col); if (why) toast({ title: "Not editable", detail: why, kind: "warn" }); return; }
    if (cell && cell.row === rowIdx && cell.col === col) return;
    setCell({ row: rowIdx, col });
  };
  const cellProps = (col: string, _row: Row, rowIdx: number) => {
    if (cell && cell.row === rowIdx && cell.col === col) return { className: "p-0! overflow-visible!" };
    const pkv = pkOf(rowIdx);
    if (isDeleted(pending, pkv)) return { className: "bg-red/10 text-dim line-through cursor-not-allowed", title: "Marked for deletion" };
    const u = pending.updates[updateKey(pkv, col)];
    const was = u ? `was: ${u.from == null ? "NULL" : rawText(u.from)}` : undefined;
    if (!editing) return u ? { className: "border-l-2 border-l-amber bg-amber/10", title: was } : undefined;
    if (!editable(col)) return { className: "cursor-not-allowed", title: lockReason(col) };
    return { className: cx("cursor-text hover:shadow-[inset_0_0_0_1px_var(--accent)]", u && "border-l-2 border-l-amber bg-amber/10"), title: was ?? "Click to edit" };
  };
  const rowClass = (_row: Row, rowIdx: number) => (isDeleted(pending, pkOf(rowIdx)) ? "bg-red/5" : undefined);
  const renderCell = (col: string, v: unknown, _row: Row, rowIdx: number) => {
    if (cell && cell.row === rowIdx && cell.col === col) {
      return <CellEditor value={v} meta={colMeta[col]} onSave={(next) => stage(rowIdx, col, next)} onCancel={() => setCell(null)} onTab={(dir, next) => { if (!same(v, next)) stage(rowIdx, col, next); moveCell({ row: rowIdx, col }, dir); }} />;
    }
    const ref = colMeta[col]?.references; const f = fmtCell(v);
    if (v == null) return <span className={cx("text-dim", editing && "italic")}>{editing ? "NULL" : f.text}</span>;
    if (!ref) return f.text;
    const exists = tables.some((t) => t.name === ref.table);
    return (
      <span className="inline-flex items-center gap-1 group/fk">
        <span>{f.text}</span>
        <button title={`Open ${ref.table} where ${ref.column} = ${f.text}`} disabled={!exists} onClick={(e) => { e.stopPropagation(); onJump(ref.table, [{ column: ref.column, op: "=", value: String(v) }]); }} className="text-accent opacity-0 group-hover/fk:opacity-100 disabled:opacity-0 cursor-pointer">{Icon.external({ size: 11 })}</button>
      </span>
    );
  };
  const rowActions = editing ? (_row: Row, rowIdx: number) => {
    const pkv = pkOf(rowIdx); const del = isDeleted(pending, pkv);
    return <button className={cx("btn-icon btn-xs", del ? "text-red-soft" : "opacity-0 group-hover:opacity-100 hover:text-red-soft")} title={del ? "Restore this row (unstage the delete)" : "Mark this row for deletion"} aria-label={del ? "Restore row" : "Delete row"} onClick={() => { setCell(null); setPending((p) => toggleDelete(p, pkv)); }}>{del ? Icon.refresh({ size: 13 }) : Icon.trash({ size: 13 })}</button>;
  } : undefined;
  const inserts = pending.inserts.length ? pending.inserts.map((ins) => (
    <InsertRow key={ins.id} ins={ins} columns={allCols} colMeta={colMeta} hasActions={!!rowActions} onChange={(c, v) => setPending((p) => setInsertValue(p, ins.id, c, v))} onRemove={() => setPending((p) => removeInsert(p, ins.id))} />
  )) : null;
  const needsValue = OPS.find((o) => o.op === draft.op)?.needsValue;

  return (
    <div className="flex-1 min-h-0 flex flex-col outline-none" tabIndex={-1} onKeyDownCapture={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); apply(); } }}>
      {/* 40px toolbar */}
      <div className="flex-none flex items-center gap-2 px-6 h-10 border-b border-border bg-surface text-[13px]">
        {filters.map((f, i) => (
          <Chip key={i} tone="accent" title={`${f.column} ${opLabel(f.op)} ${f.value ?? ""}`}><span className="font-mono">{f.column}</span><span className="text-dim">{opLabel(f.op)}</span>{OPS.find((o) => o.op === f.op)?.needsValue && <span className="font-mono truncate max-w-[120px]">{f.value}</span>}<button className="ml-0.5 text-dim hover:text-text cursor-pointer" aria-label="Remove filter" onClick={() => guarded(() => { setFilters((x) => x.filter((_, k) => k !== i)); setPage(1); })}>{Icon.close({ size: 11 })}</button></Chip>
        ))}
        {adding ? (
          <div className="flex items-center gap-1.5">
            <select className="select h-7 text-[12.5px] w-[160px] font-mono" value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })}>{table.columns.filter((c) => !c.secret).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>
            <select className="select h-7 text-[12.5px] w-[100px]" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as FilterOp })}>{OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
            {needsValue && <input autoFocus className="input h-7 text-[12.5px] w-[180px] font-mono" placeholder={draft.op === "like" ? "%value%" : "value"} value={draft.value || ""} onChange={(e) => setDraft({ ...draft, value: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addFilter(); if (e.key === "Escape") setAdding(false); }} />}
            <button className="btn-primary btn-sm" onClick={addFilter}>Apply</button><button className="btn-subtle btn-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : <button className="btn-subtle btn-sm" onClick={() => setAdding(true)}>{Icon.plus({ size: 13 })} Add filter</button>}
        <div className="flex-1" />
        {sort && <button className="btn-subtle btn-xs" onClick={() => guarded(() => setSort(null))} title="Clear sort">sorted by {sort.column} {Icon.close({ size: 11 })}</button>}
        <span className="text-[12px] text-dim" title={r.data?.hidden.length ? `Withheld: ${r.data.hidden.join(", ")}` : undefined}>{table.columns.length} columns</span>
        {r.data && (r.data.hidden.length > 0 || r.data.masked.length > 0) && <LockChip kind={r.data.hidden.length ? "hidden" : "masked"} count={r.data.hidden.length + r.data.masked.length} />}
        <button className="btn-subtle btn-sm" disabled={!rows.length} onClick={() => r.data && exportRows(rows, r.data.columns, "csv", `${project.slug}-${env}-${table.name}`)}>Export CSV</button>
        {editing && <button className="btn-subtle btn-sm" disabled={applying} onClick={addRow}>{Icon.plus({ size: 13 })} Add row</button>}
        <button className={cx("btn-sm", editing ? "btn-primary" : "btn-subtle")} disabled={!canEdit} aria-pressed={editing} title={!keyCol ? "This table has no primary key, so Arkus can't target a single row safely" : editing ? "Leave edit mode (staged changes stay until you apply or discard them)" : "Edit cells, add and delete rows; nothing is written until you apply"} onClick={() => { setEditing((e) => !e); setCell(null); }}><PencilIcon /> {editing ? "Done" : "Edit"}</button>
      </div>
      {editing && (
        <div className="flex-none flex items-center gap-2 px-6 h-7 border-b border-border bg-surface text-[12px] text-muted border-t-2 border-t-accent">
          <Chip tone="accent">Edit mode</Chip>
          <span>Click a cell to change it · Enter stages · Esc cancels · Tab moves on · changes are written when you apply</span>
          {env === "prod" && <span className="text-amber">Applying on prod asks for a typed confirmation.</span>}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto relative bg-bg">
        {r.loading && !r.data && <div className="absolute inset-0 flex items-center justify-center"><Spinner /></div>}
        {r.error && (r.error === "schema-only connection"
          ? <EmptyState icon={Icon.lock()} title="This connection is schema only" hint="Rows stay off for this environment. Change the connection to browse data." />
          : <EmptyState icon={Icon.warn()} title="Could not load rows" hint={r.error} action={<button className="btn-primary" onClick={() => r.reload()}>Try again</button>} />)}
        {r.data && (rows.length || inserts ? (
          <ResultsTable columns={r.data.columns} rows={viewRows} masked={r.data.masked} hidden={r.data.hidden} sort={sort} onSort={onSort} renderCell={renderCell} onCellClick={editing ? onCellClick : undefined} cellProps={cellProps} rowClass={rowClass} rowActions={rowActions} before={inserts} colMeta={colMeta} />
        ) : <EmptyState icon={Icon.table()} title={filters.length ? "No rows match these filters" : "This table is empty"} hint={filters.length ? "Remove a filter to see more rows." : `${table.name} has no rows on ${env}.`} action={filters.length ? <button className="btn-primary" onClick={() => guarded(() => { setFilters([]); setPage(1); })}>Clear filters</button> : canEdit ? <button className="btn-primary" onClick={addRow}>{Icon.plus({ size: 13 })} Add the first row</button> : undefined} />)}
      </div>

      {count > 0 && <ChangesBar staged={staged} engine={engine} applying={applying} problems={problems} showSql={showSql} setShowSql={setShowSql} onApply={apply} onDiscard={discard} />}
      <div className="flex-none flex items-center gap-3 px-6 h-9 border-t border-border bg-surface text-[12px] text-muted">
        <span>{r.data ? `${r.data.totalExact ? "" : "about "}${fmtNum(r.data.total)} rows` : "..."}</span>
        {r.data && <span className="text-dim">{r.data.ms} ms{r.loading ? " · refreshing" : ""}</span>}
        <div className="flex-1" />
        <button className="btn-subtle btn-xs" disabled={page <= 1} onClick={() => guarded(() => setPage((p) => p - 1))} aria-label="Previous page">{Icon.chevron({ size: 13, className: "rotate-180" })}</button>
        <span className="tabular-nums">page {page}{r.data?.totalExact || (r.data && r.data.total > 0) ? ` of ${pages}` : ""}</span>
        <button className="btn-subtle btn-xs" disabled={!!r.data && (rows.length < PAGE || (r.data.totalExact && page >= pages))} onClick={() => guarded(() => setPage((p) => p + 1))} aria-label="Next page">{Icon.chevron({ size: 13 })}</button>
      </div>
    </div>
  );
}
