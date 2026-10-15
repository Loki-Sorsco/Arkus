"use client";
// Manual schema changes, column and index level: Add column (previews and applies — the plan-drafting
// AddColumnModal in inspector.tsx stays as it is), Rename, Change (type / nullable / default; SQLite cannot do
// this in place and the dialog says so), Drop column (typed table name), Add index and Drop index. Every
// dialog shows the SQL from /db/schema/preview before its button; the shared plumbing is in schema-modals.tsx.
import { useEffect, useMemo, useState } from "react";
import { Field, Icon, Modal, Spinner } from "@/components/ui";
import { cx } from "@/lib/ui";
import type { DbColumn, DbTable } from "@/components/screens/db-shared";
import { ConfirmInput, DEFAULT_HINT, IDENT_OK, NameInput, SqlPreview, TypeSelect, nameHint, refTargets, splitRef, typesFor, useSchemaApply, useSchemaPreview, type ChangeOf } from "./schema-modals";
import type { SchemaChange } from "@/lib/arkus/ddl";

type Base = { open: boolean; onClose: () => void; table: DbTable; engine: string | null };
export const SQLITE_ALTER = "SQLite cannot change a column in place; add a new column, copy the data, then drop the old one.";
const Check = ({ checked, onChange, children, disabled }: { checked: boolean; onChange: (b: boolean) => void; children: React.ReactNode; disabled?: boolean }) => (
  <label className={cx("flex items-center gap-2 text-[13px] text-text-2", disabled && "opacity-50")}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {children}</label>
);

// ---------------------------------------------------------------- Add column

export function AddColumnDdlModal({ open, onClose, table, engine, tables }: Base & { tables: DbTable[] }) {
  const [name, setName] = useState(""); const [type, setType] = useState(""); const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState(""); const [unique, setUnique] = useState(false); const [ref, setRef] = useState("");
  useEffect(() => { if (open) { setName(""); setType(typesFor(engine)[0]); setNullable(true); setDef(""); setUnique(false); setRef(""); } }, [open, engine]);
  const change = useMemo<ChangeOf<"add_column"> | null>(() => {
    if (!IDENT_OK.test(name.trim()) || !type.trim()) return null;
    return { kind: "add_column", table: table.name, column: name.trim(), type: type.trim(), nullable, ...(def.trim() ? { default: def.trim() } : {}), ...(unique ? { unique: true } : {}), ...(ref ? { references: splitRef(ref) } : {}) };
  }, [table.name, name, type, nullable, def, unique, ref]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const targets = useMemo(() => refTargets(tables), [tables]);
  const dup = table.columns.some((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  const add = () => change && run(change, { success: `Column ${table.name}.${change.column} added`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={520} title={<span>Add a column to <span className="font-mono">{table.name}</span></span>} subtitle={<span className="prose">Runs ALTER TABLE on the {engine || "connected"} database as soon as you confirm.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary dev-only" disabled={!preview.ready || busy || dup} onClick={add}>{busy ? <Spinner /> : Icon.plus({ size: 13 })} Add column</button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Column name" hint={dup ? <span className="text-amber">{table.name} already has a column with this name.</span> : nameHint(name)}><NameInput value={name} onChange={setName} placeholder="notes" autoFocus /></Field>
        <Field label="Type"><TypeSelect engine={engine} value={type} onChange={setType} className="w-full" /></Field>
        <Field label="Default" hint={DEFAULT_HINT}><input className="input font-mono" value={def} onChange={(e) => setDef(e.target.value)} placeholder="none" /></Field>
        {targets.length > 0 && <Field label="References"><select className="select font-mono" value={ref} onChange={(e) => setRef(e.target.value)}><option value="">none</option>{targets.filter((t) => !t.startsWith(table.name + ".")).map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>}
        <div className="flex flex-col gap-1.5">
          <Check checked={nullable} onChange={setNullable}>Nullable <span className="text-dim">(recommended: existing rows keep working)</span></Check>
          <Check checked={unique} onChange={setUnique}>Unique</Check>
        </div>
        <SqlPreview {...preview} engine={engine} hint="Name the column to see the SQL." />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Rename / change / drop column

export function RenameColumnModal({ open, onClose, table, engine, column }: Base & { column: DbColumn }) {
  const [to, setTo] = useState("");
  useEffect(() => { if (open) setTo(""); }, [open]);
  const change = useMemo<ChangeOf<"rename_column"> | null>(() => (IDENT_OK.test(to.trim()) && to.trim() !== column.name ? { kind: "rename_column", table: table.name, column: column.name, to: to.trim() } : null), [table.name, column.name, to]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const rename = () => change && run(change, { success: `Column renamed to ${change.to}`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={480} title={<span>Rename <span className="font-mono">{table.name}.{column.name}</span></span>} subtitle={<span className="prose">Code that reads the old name will break until it is updated.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary dev-only" disabled={!preview.ready || busy} onClick={rename}>{busy ? <Spinner /> : null} Rename column</button></>}>
      <div className="flex flex-col gap-4">
        <Field label="New name" hint={nameHint(to)}><NameInput value={to} onChange={setTo} placeholder={column.name} autoFocus /></Field>
        <SqlPreview {...preview} engine={engine} hint="Type a new name to see the SQL." />
      </div>
    </Modal>
  );
}

type DefMode = "keep" | "none" | "value";
export function ChangeColumnModal({ open, onClose, table, engine, column }: Base & { column: DbColumn }) {
  const sqlite = engine === "sqlite";
  const [type, setType] = useState(""); const [nullable, setNullable] = useState<"keep" | "yes" | "no">("keep");
  const [defMode, setDefMode] = useState<DefMode>("keep"); const [def, setDef] = useState("");
  useEffect(() => { if (open) { setType(column.type || ""); setNullable("keep"); setDefMode("keep"); setDef(column.default ?? ""); } }, [open, column]);
  const change = useMemo<SchemaChange | null>(() => {
    if (sqlite) return null;
    const c: ChangeOf<"alter_column"> = { kind: "alter_column", table: table.name, column: column.name };
    if (type.trim() && type.trim().toLowerCase() !== (column.type || "").toLowerCase()) c.type = type.trim();
    if (nullable !== "keep") c.nullable = nullable === "yes";
    if (defMode === "none") c.default = null; else if (defMode === "value" && def.trim()) c.default = def.trim();
    return c.type === undefined && c.nullable === undefined && c.default === undefined ? null : c;
  }, [sqlite, table.name, column, type, nullable, defMode, def]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const apply = () => change && run(change, { success: `Column ${table.name}.${column.name} changed`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={500} title={<span>Change <span className="font-mono">{table.name}.{column.name}</span></span>} subtitle={<span className="prose">Currently <span className="font-mono">{column.type || "unknown"}</span>, {column.nullable ? "nullable" : "not null"}{column.default != null && column.default !== "" ? <>, default <span className="font-mono">{column.default}</span></> : ""}.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary dev-only" disabled={sqlite || !preview.ready || busy} onClick={apply}>{busy ? <Spinner /> : null} Change column</button></>}>
      {sqlite ? <div className="text-[13px] text-text-2 prose border border-amber/40 bg-amber/10 rounded-[6px] px-3 py-2.5">{SQLITE_ALTER}</div> : (
        <div className="flex flex-col gap-3">
          <Field label="Type" hint={engine === "postgres" ? "Postgres converts existing values; the change fails if any value does not fit." : "MySQL rewrites the column with the full new definition."}><TypeSelect engine={engine} value={type} onChange={setType} className="w-full" /></Field>
          <Field label="Nullable"><select className="select" value={nullable} onChange={(e) => setNullable(e.target.value as "keep" | "yes" | "no")}><option value="keep">keep ({column.nullable ? "nullable" : "not null"})</option><option value="yes">nullable</option><option value="no">not null</option></select></Field>
          <Field label="Default" hint={defMode === "value" ? DEFAULT_HINT : undefined}>
            <div className="flex gap-2">
              <select className="select w-[150px] flex-none" value={defMode} onChange={(e) => setDefMode(e.target.value as DefMode)}><option value="keep">keep</option><option value="none">no default</option><option value="value">set to…</option></select>
              {defMode === "value" && <input className="input font-mono flex-1" value={def} onChange={(e) => setDef(e.target.value)} placeholder="0" autoFocus />}
            </div>
          </Field>
          <SqlPreview {...preview} engine={engine} hint="Change the type, nullability or default to see the SQL." />
        </div>
      )}
    </Modal>
  );
}

export function DropColumnModal({ open, onClose, table, engine, column }: Base & { column: DbColumn }) {
  const [typed, setTyped] = useState("");
  useEffect(() => { if (open) setTyped(""); }, [open]);
  const change = useMemo<SchemaChange>(() => ({ kind: "drop_column", table: table.name, column: column.name }), [table.name, column.name]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const drop = () => run(change, { confirm: typed, success: `Column ${table.name}.${column.name} dropped`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={480} title={<span className="text-red-soft">Drop <span className="font-mono">{table.name}.{column.name}</span></span>} subtitle={<span className="prose">Deletes the column and every value in it.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-danger dev-only" disabled={!preview.ready || busy || typed !== table.name} onClick={drop}>{busy ? <Spinner /> : Icon.trash({ size: 13 })} Drop column</button></>}>
      <div className="flex flex-col gap-4">
        <SqlPreview {...preview} engine={engine} />
        <ConfirmInput table={table.name} value={typed} onChange={setTyped} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Indexes

export function AddIndexModal({ open, onClose, table, engine }: Base) {
  const [picked, setPicked] = useState<string[]>([]); const [unique, setUnique] = useState(false); const [name, setName] = useState("");
  useEffect(() => { if (open) { setPicked([]); setUnique(false); setName(""); } }, [open]);
  const change = useMemo<SchemaChange | null>(() => (picked.length && (!name.trim() || IDENT_OK.test(name.trim())) ? { kind: "create_index", table: table.name, columns: picked, ...(unique ? { unique: true } : {}), ...(name.trim() ? { name: name.trim() } : {}) } : null), [table.name, picked, unique, name]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const toggle = (c: string) => setPicked((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));
  const add = () => change && run(change, { success: `Index on ${table.name} (${picked.join(", ")}) created`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={500} title={<span>Add an index to <span className="font-mono">{table.name}</span></span>} subtitle={<span className="prose">Pick the columns in the order queries filter on them.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary dev-only" disabled={!preview.ready || busy} onClick={add}>{busy ? <Spinner /> : Icon.plus({ size: 13 })} Add index</button></>}>
      <div className="flex flex-col gap-3">
        <div>
          <span className="label">Columns</span>
          <div className="card max-h-[220px] overflow-auto px-3 py-2 flex flex-col gap-1.5">
            {table.columns.filter((c) => !c.secret).map((c) => <Check key={c.name} checked={picked.includes(c.name)} onChange={() => toggle(c.name)}><span className="font-mono">{c.name}</span><span className="text-dim font-mono text-[12px]">{c.type}</span>{picked.includes(c.name) && picked.length > 1 && <span className="text-dim text-[11px]">#{picked.indexOf(c.name) + 1}</span>}</Check>)}
          </div>
        </div>
        <Check checked={unique} onChange={setUnique}>Unique <span className="text-dim">(fails if the column already has duplicate values)</span></Check>
        <Field label="Index name" hint={nameHint(name) || "Optional; generated from the table and columns when empty."}><NameInput value={name} onChange={setName} placeholder={`${table.name.split(".").pop()}_${picked.join("_") || "column"}_${unique ? "key" : "idx"}`} /></Field>
        <SqlPreview {...preview} engine={engine} hint="Pick at least one column to see the SQL." />
      </div>
    </Modal>
  );
}

export function DropIndexModal({ open, onClose, table, engine, index }: Base & { index: DbTable["indexes"][number] }) {
  const change = useMemo<SchemaChange | null>(() => (index.name ? { kind: "drop_index", table: table.name, name: index.name } : null), [table.name, index.name]);
  const preview = useSchemaPreview(open ? change : null);
  const { run, busy } = useSchemaApply();
  const drop = () => change && run(change, { success: `Index ${index.name} dropped`, after: onClose });
  return (
    <Modal open={open} onClose={onClose} width={480} title={<span className="text-red-soft">Drop index <span className="font-mono">{index.name || "(unnamed)"}</span></span>} subtitle={<span className="prose">Queries that filter on <span className="font-mono">{index.columns.join(", ")}</span> may get slower; no data is lost.</span>}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-danger dev-only" disabled={!preview.ready || busy} onClick={drop}>{busy ? <Spinner /> : Icon.trash({ size: 13 })} Drop index</button></>}>
      {index.name ? <SqlPreview {...preview} engine={engine} /> : <div className="text-[13px] text-text-2 prose">This index has no name in the snapshot, so it cannot be dropped from here.</div>}
    </Modal>
  );
}
