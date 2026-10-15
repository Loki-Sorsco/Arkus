"use client";
// Manual schema changes, table level: the shared plumbing (POST /db/schema/preview renders the exact statements
// as the form changes; POST /db/schema/change runs them through the prod gate, toasts and reloads every schema
// view) plus the New table, Rename table and Drop table dialogs. Column and index dialogs live in
// schema-column-modals.tsx. Every dialog shows the SQL before its button and the button says what it does.
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Field, Icon, Modal, Spinner, useToast } from "@/components/ui";
import { cx } from "@/lib/ui";
import { SqlEditor } from "@/components/screens/db-sql-editor";
import { dbBase, post, type DbTable } from "@/components/screens/db-shared";
import { notifySchemaChanged } from "@/components/tabs/db-common";
import type { NewColumn, SchemaChange } from "@/lib/arkus/ddl";

export type ChangeOf<K extends SchemaChange["kind"]> = Extract<SchemaChange, { kind: K }>;

type PreviewResp = { sql?: string[]; error?: string };
export type ChangeResp = { ok?: boolean; sql?: string[]; table?: string; error?: string; syncError?: string; status: number };

export const COMMON_TYPES: Record<string, string[]> = {
  postgres: ["text", "varchar(255)", "integer", "bigint", "serial", "boolean", "numeric(10,2)", "real", "double precision", "date", "timestamp", "timestamptz", "uuid", "json", "jsonb"],
  mysql: ["varchar(255)", "text", "int", "bigint", "tinyint(1)", "boolean", "decimal(10,2)", "double", "date", "datetime", "timestamp", "json"],
  sqlite: ["TEXT", "INTEGER", "REAL", "NUMERIC", "BLOB", "BOOLEAN", "DATETIME"],
};
export const typesFor = (engine: string | null | undefined) => COMMON_TYPES[engine || ""] || COMMON_TYPES.postgres;
export const idType = (engine: string | null | undefined) => (engine === "postgres" ? "serial" : engine === "mysql" ? "int" : "INTEGER");
export const IDENT_OK = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const DEFAULT_HINT = "Numbers, true / false, now() and CURRENT_TIMESTAMP are used as written; anything else becomes a quoted string.";
/** "table.column" → { table, column } (table names may contain a schema dot). */
export const splitRef = (s: string) => { const i = s.lastIndexOf("."); return i > 0 ? { table: s.slice(0, i), column: s.slice(i + 1) } : undefined; };
/** Columns another table may reference: primary keys and unique columns, as "table.column". */
export const refTargets = (tables: DbTable[]) => tables.flatMap((t) => t.columns.filter((c) => (c.pk || c.unique) && !c.secret).map((c) => `${t.name}.${c.name}`));

/** Common types for the engine in a select, with "Other…" turning into a free-text input. */
export function TypeSelect({ engine, value, onChange, className, autoFocus }: { engine: string | null; value: string; onChange: (v: string) => void; className?: string; autoFocus?: boolean }) {
  const common = typesFor(engine);
  const [custom, setCustom] = useState(() => !!value && !common.includes(value));
  if (custom) return (
    <span className={cx("flex gap-1 items-center", className)}>
      <input className="input input-sm font-mono flex-1 min-w-0" value={value} onChange={(e) => onChange(e.target.value)} placeholder={engine === "mysql" ? "varchar(120)" : engine === "sqlite" ? "TEXT" : "varchar(120)"} autoFocus />
      <button type="button" className="btn-icon btn-xs flex-none" title="Back to the common types" aria-label="Back to the common types" onClick={() => { setCustom(false); onChange(common[0]); }}>{Icon.close({ size: 11 })}</button>
    </span>
  );
  return (
    <select className={cx("select input-sm font-mono", className)} value={common.includes(value) ? value : ""} autoFocus={autoFocus} onChange={(e) => { if (e.target.value === "__other") { setCustom(true); onChange(""); } else onChange(e.target.value); }}>
      {!common.includes(value) && <option value="">choose a type</option>}
      {common.map((t) => <option key={t} value={t}>{t}</option>)}
      <option value="__other">Other…</option>
    </select>
  );
}

/** Debounced POST /db/schema/preview for the change the form currently describes (null = nothing to render yet). */
export function useSchemaPreview(change: SchemaChange | null) {
  const { project, env } = useWorkspace();
  const key = change ? JSON.stringify(change) : "";
  const [state, setState] = useState<{ key: string; sql: string[]; error: string | null; loading: boolean }>({ key: "", sql: [], error: null, loading: false });
  useEffect(() => {
    if (!key) { setState({ key, sql: [], error: null, loading: false }); return; }
    let on = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      const r: PreviewResp & { status: number } = await post<PreviewResp>(`${dbBase(project.slug)}/schema/preview`, { env, change: JSON.parse(key) }).catch((e) => ({ error: (e as Error).message, status: 0 }));
      if (on) setState({ key, sql: r.sql || [], error: r.sql ? null : r.error || "Could not render the SQL", loading: false });
    }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [key, project.slug, env]);
  const ready = !!key && state.key === key && !state.loading && !state.error && state.sql.length > 0;
  return { sql: state.sql, error: state.error, loading: state.loading, ready };
}

/** The statements a dialog is about to run, or the reason the server refused to render them. */
export function SqlPreview({ sql, error, loading, engine, hint }: { sql: string[]; error: string | null; loading: boolean; engine: string | null; hint?: string }) {
  const text = sql.map((s) => s + ";").join("\n");
  const lines = Math.max(2, text.split("\n").length);
  return (
    <div>
      <span className="label">SQL that will run</span>
      {error ? <div className="text-[12.5px] text-red-soft prose border border-red/30 bg-red/5 rounded-[6px] px-3 py-2">{error}</div>
        : text ? <div className={cx("card overflow-hidden transition-opacity", loading && "opacity-60")} style={{ height: Math.min(260, lines * 20 + 14) }}><SqlEditor value={text} engine={engine} tables={[]} readOnly lineNumbers={false} /></div>
        : <div className="text-[12.5px] text-dim prose border border-dashed border-border rounded-[6px] px-3 py-2">{loading ? "Rendering…" : hint || "Fill in the form to see the SQL."}</div>}
    </div>
  );
}

/** POST /db/schema/change through the prod gate; toasts, reloads every schema view, then runs `after`. */
export function useSchemaApply() {
  const { project, env, gate } = useWorkspace();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = (change: SchemaChange, opts: { confirm?: string; success: string; after?: (r: ChangeResp) => void | Promise<void> }) => gate(async () => {
    setBusy(true);
    try {
      const r = await post<ChangeResp>(`${dbBase(project.slug)}/schema/change`, { env, change, ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}) });
      if (!r.ok) throw new Error(r.error || `the change failed (${r.status})`);
      await notifySchemaChanged();
      toast({ title: opts.success, detail: r.syncError ? `Applied, but the schema sync failed: ${r.syncError}` : (r.sql || []).join("; ").slice(0, 200), kind: r.syncError ? "warn" : "ok" });
      await opts.after?.(r);
    } catch (e) { toast({ title: "Schema change failed", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(false); }
  });
  return { run, busy };
}

/** "Type the table name to confirm" input used by every drop dialog. */
export function ConfirmInput({ table, value, onChange }: { table: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Type the table name to confirm" hint={<span className="prose">Data in it is lost and this cannot be undone.</span>}>
      <input className="input font-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={table} autoComplete="off" spellCheck={false} />
    </Field>
  );
}

export const NameInput = ({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) => (
  <input className="input font-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} autoComplete="off" spellCheck={false} />
);
export const nameHint = (v: string) => (v && !IDENT_OK.test(v) ? "Letters, digits and _ only, starting with a letter, at most 63 characters." : undefined);

// ---------------------------------------------------------------- New table

type Draft = { name: string; type: string; pk: boolean; nullable: boolean; def: string; unique: boolean; ref: string };
const blank = (engine: string | null, first = false): Draft => first ? { name: "id", type: idType(engine), pk: true, nullable: false, def: "", unique: false, ref: "" } : { name: "", type: typesFor(engine)[0], pk: false, nullable: true, def: "", unique: false, ref: "" };
const toNewColumn = (d: Draft): NewColumn => ({ name: d.name.trim(), type: d.type.trim(), pk: d.pk || undefined, nullable: d.pk ? false : d.nullable, ...(d.def.trim() ? { default: d.def.trim() } : {}), unique: d.unique || undefined, ...(d.ref ? { references: splitRef(d.ref) } : {}) });

export function NewTableModal({ open, onClose, engine, tables }: { open: boolean; onClose: () => void; engine: string | null; tables: DbTable[] }) {
  const { go } = useWorkspace();
  const [name, setName] = useState("");
  const [cols, setCols] = useState<Draft[]>([]);
  useEffect(() => { if (open) { setName(""); setCols([blank(engine, true), blank(engine)]); } }, [open, engine]);
  const change = useMemo<SchemaChange | null>(() => {
    const columns = cols.filter((c) => c.name.trim()).map(toNewColumn);
    if (!IDENT_OK.test(name.trim()) || !columns.length || columns.some((c) => !c.type)) return null;
    return { kind: "create_table", table: name.trim(), columns };
  }, [name, cols]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const targets = useMemo(() => refTargets(tables), [tables]);
  const update = (i: number, patch: Partial<Draft>) => setCols((l) => l.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const create = () => change && run(change, { success: `Table ${change.table} created`, after: () => { onClose(); go("database", { view: "table", sel: `table:${change.table}` }); } });
  return (
    <Modal open={open} onClose={onClose} width={860} title="New table" subtitle={<span className="prose">Runs CREATE TABLE on the {engine || "connected"} database as soon as you confirm.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary dev-only" disabled={!preview.ready || busy} onClick={create}>{busy ? <Spinner /> : Icon.plus({ size: 13 })} Create table</button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Table name" hint={nameHint(name)}><NameInput value={name} onChange={setName} placeholder="orders" autoFocus /></Field>
        <div>
          <div className="flex items-center justify-between mb-1"><span className="label mb-0">Columns</span><button className="btn-subtle btn-xs" onClick={() => setCols((l) => [...l, blank(engine)])}>{Icon.plus({ size: 12 })} Add row</button></div>
          <div className="card overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Name</th><th>Type</th><th title="Primary key">PK</th><th>Nullable</th><th>Default</th><th>Unique</th><th>References</th><th /></tr></thead>
              <tbody>
                {cols.map((c, i) => (
                  <tr key={i}>
                    <td className="min-w-[140px]"><input className="input input-sm font-mono" value={c.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="column_name" autoComplete="off" spellCheck={false} /></td>
                    <td className="min-w-[150px]"><TypeSelect engine={engine} value={c.type} onChange={(type) => update(i, { type })} /></td>
                    <td className="text-center"><input type="checkbox" checked={c.pk} onChange={(e) => update(i, { pk: e.target.checked, nullable: e.target.checked ? false : c.nullable })} /></td>
                    <td className="text-center"><input type="checkbox" checked={c.nullable} disabled={c.pk} onChange={(e) => update(i, { nullable: e.target.checked })} /></td>
                    <td className="min-w-[110px]"><input className="input input-sm font-mono" value={c.def} onChange={(e) => update(i, { def: e.target.value })} placeholder="none" title={DEFAULT_HINT} /></td>
                    <td className="text-center"><input type="checkbox" checked={c.unique} disabled={c.pk} onChange={(e) => update(i, { unique: e.target.checked })} /></td>
                    <td className="min-w-[150px]"><select className="select input-sm font-mono" value={c.ref} onChange={(e) => update(i, { ref: e.target.value })}><option value="">none</option>{targets.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
                    <td className="text-right"><button className="btn-icon btn-xs" title="Remove this column" aria-label="Remove this column" onClick={() => setCols((l) => l.filter((_, k) => k !== i))}>{Icon.trash({ size: 12 })}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[12px] text-dim mt-1 prose">Rows without a name are ignored. {DEFAULT_HINT}</div>
        </div>
        <SqlPreview {...preview} engine={engine} hint="Name the table and at least one column to see the SQL." />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Rename / drop table

export function RenameTableModal({ open, onClose, table, engine }: { open: boolean; onClose: () => void; table: string; engine: string | null }) {
  const { go } = useWorkspace();
  const [to, setTo] = useState("");
  useEffect(() => { if (open) setTo(""); }, [open]);
  const change = useMemo<ChangeOf<"rename_table"> | null>(() => (IDENT_OK.test(to.trim()) && to.trim() !== table ? { kind: "rename_table", table, to: to.trim() } : null), [table, to]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const rename = () => change && run(change, { success: `Table renamed to ${change.to}`, after: () => { onClose(); go("database", { view: "table", sel: `table:${change.to}` }); } });
  return (
    <Modal open={open} onClose={onClose} width={480} title={<span>Rename <span className="font-mono">{table}</span></span>} subtitle={<span className="prose">Code that uses the old name will break until it is updated.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary dev-only" disabled={!preview.ready || busy} onClick={rename}>{busy ? <Spinner /> : null} Rename table</button></>}>
      <div className="flex flex-col gap-4">
        <Field label="New name" hint={nameHint(to)}><NameInput value={to} onChange={setTo} placeholder={table} autoFocus /></Field>
        <SqlPreview {...preview} engine={engine} hint="Type a new name to see the SQL." />
      </div>
    </Modal>
  );
}

export function DropTableModal({ open, onClose, table, engine }: { open: boolean; onClose: () => void; table: string; engine: string | null }) {
  const [typed, setTyped] = useState("");
  useEffect(() => { if (open) setTyped(""); }, [open]);
  const change = useMemo<SchemaChange>(() => ({ kind: "drop_table", table }), [table]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const drop = () => run(change, { confirm: typed, success: `Table ${table} dropped`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={480} title={<span className="text-red-soft">Drop <span className="font-mono">{table}</span></span>} subtitle={<span className="prose">Deletes the table and every row in it.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-danger dev-only" disabled={!preview.ready || busy || typed !== table} onClick={drop}>{busy ? <Spinner /> : Icon.trash({ size: 13 })} Drop table</button></>}>
      <div className="flex flex-col gap-4">
        <SqlPreview {...preview} engine={engine} />
        <ConfirmInput table={table} value={typed} onChange={setTyped} />
      </div>
    </Modal>
  );
}
