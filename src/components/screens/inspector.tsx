"use client";
// Right-hand inspector: whatever is selected (table, column, endpoint, page, external) with
// "used by" impact, source peek, and the edit affordances that draft changes.
import { useEffect, useState } from "react";
import { InspectorHeader, useWorkspace } from "@/components/shell/workspace";
import { OpenInEditorLink } from "@/components/screens/code-editor";
import { PagePreview } from "@/components/screens/page-preview";
import { Chip, Confidence, Field, Icon, MethodBadge, Modal, Ref, Section, Spinner } from "@/components/ui";
import { cx, useApi } from "@/lib/ui";
import type { GNode } from "@/lib/arkus/types";

type Impact = { usedBy: Record<string, { key: string; name: string; depth: number }[]>; uses: Record<string, { key: string; name: string }[]>; risk: string; summary: string };
const TYPES = ["Text", "Email", "Phone", "Number", "Date", "Yes/no"];
const CRUMB: Record<string, string> = { table: "Database › table", column: "Database › column", endpoint: "API endpoint", screen: "Page", component: "Component", external: "External service", apicall: "API call" };

export function Inspector({ extra }: { extra?: React.ReactNode }) {
  const { graph, selection, select, project, addDraft, openNode } = useWorkspace();
  const node = graph?.nodes.find((n) => n.key === selection) || null;
  const impact = useApi<Impact>(selection ? `/api/projects/${project.slug}/impact?key=${encodeURIComponent(selection)}` : null);
  const [addCol, setAddCol] = useState(false);
  if (!selection || !node) return null;
  const cols = (node.attrs?.columns as { name: string; type: string; pk?: boolean; unique?: boolean; nullable?: boolean; references?: { table: string; column: string } }[] | undefined) || [];
  const fields = (node.attrs?.fields as { label: string; name?: string; uiType: string; required?: boolean }[] | undefined) || [];
  const canOpen = node.type === "table" || node.type === "endpoint" || node.type === "screen" || node.type === "column" || ((node.type === "component" || node.type === "apicall") && !!node.file);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <InspectorHeader crumb={CRUMB[node.type] || node.type} title={<span className="font-mono">{node.name}</span>} onClose={() => select(null)} />
      <div className="flex-1 overflow-auto p-3 flex flex-col gap-4 select-text">
        <div className="flex flex-wrap gap-1.5 items-center">
          {node.type === "endpoint" && <MethodBadge method={String(node.attrs?.method)} />}
          {node.type === "endpoint" && <Chip tone={node.attrs?.auth === true ? "green" : node.attrs?.auth === false ? "amber" : "muted"}>{node.attrs?.auth === true ? "auth required" : node.attrs?.auth === false ? "public" : "auth unknown"}</Chip>}
          {node.type === "table" && <Chip tone="teal">{String(node.attrs?.source || "static")}{node.attrs?.rowEstimate ? ` · ~${Number(node.attrs.rowEstimate).toLocaleString()} rows` : ""}</Chip>}
          <Confidence value={node.confidence} />
          {canOpen && <button className="btn-ghost btn-xs ml-auto" onClick={() => openNode(node.key)}>Open {Icon.chevron({ size: 12 })}</button>}
        </div>
        {node.file && <div className="text-[11.5px] font-mono text-dim truncate -mt-3" title={node.file}>{node.file}{node.lineStart ? `:${node.lineStart}` : ""}</div>}

        {node.type === "table" && (
          <Section title={`Columns · ${cols.length}`} right={<button className="btn-subtle btn-xs dev-only" onClick={() => setAddCol(true)}>{Icon.plus({ size: 12 })} Add column</button>}>
            <div className="border border-border rounded-[6px] overflow-hidden bg-bg-deep/40">
              {cols.map((c) => (
                <div key={c.name} className="flex items-center gap-2 px-2.5 h-7 text-[12.5px] border-b border-border/50 last:border-0 hover:bg-surface-2 cursor-pointer" onClick={() => select(`column:${node.name}.${c.name}`)}>
                  <span className="w-3 text-center text-[10px] text-dim" title={c.pk ? "primary key" : c.references ? "foreign key" : c.unique ? "unique" : ""}>{c.pk ? "●" : c.references ? "◆" : c.unique ? "▤" : ""}</span>
                  <span className="font-mono">{c.name}</span>
                  <span className="text-dim ml-auto font-mono text-[11px]">{c.type}{c.nullable ? "?" : ""}</span>
                  {c.references && <span className="text-[11px] text-teal">→ {c.references.table}</span>}
                </div>
              ))}
              {!cols.length && <div className="p-3 text-[12.5px] text-dim">No columns known. Connect the database to introspect it.</div>}
            </div>
          </Section>
        )}
        {node.type === "column" && <ColumnDetail node={node} />}
        {node.type === "screen" && (
          <Section title="Preview"><PagePreview path={node.name} /></Section>
        )}
        {node.type === "screen" && (
          <Section title={`Fields · ${fields.length}`}>
            {fields.length ? <div className="border border-border rounded-[6px] overflow-hidden bg-bg-deep/40">{fields.map((f, i) => <div key={i} className="flex items-center gap-2 px-2.5 h-7 text-[12.5px] border-b border-border/50 last:border-0"><span>{f.label}</span><span className="text-dim ml-auto">{f.uiType}{f.required ? " · required" : ""}</span></div>)}</div> : <div className="text-[12.5px] text-dim">Display page — no form fields.</div>}
          </Section>
        )}
        {node.type === "endpoint" && (
          <Section title="Request keys">
            {((node.attrs?.bodyKeys as { name: string; type?: string; required?: boolean }[]) || []).length ? <div className="flex flex-wrap gap-1">{(node.attrs!.bodyKeys as { name: string; type?: string; required?: boolean }[]).map((b) => <Chip key={b.name} tone="muted"><span className="font-mono">{b.name}</span>{b.type ? <span className="text-dim">· {b.type}</span> : null}{b.required ? <span className="text-amber">*</span> : null}</Chip>)}</div> : <div className="text-[12.5px] text-dim">No request body detected.</div>}
          </Section>
        )}
        {node.type === "apicall" && <div className="text-[12.5px] text-muted">Called with <span className="font-mono">{String(node.attrs?.lib)}</span>{node.attrs?.dynamic ? " · URL built at runtime" : ""}{node.attrs?.resolved ? "" : " · no matching endpoint found"}</div>}

        <Section title="Used by" right={impact.loading ? <Spinner /> : undefined}>
          {impact.data && (
            <>
              <div className={cx("text-[12.5px]", impact.data.risk === "high" ? "text-red-soft" : impact.data.risk === "medium" ? "text-amber" : "text-muted")}>{impact.data.summary}{impact.data.risk !== "low" ? ` · ${impact.data.risk} risk to change` : ""}</div>
              {Object.entries(impact.data.usedBy).filter(([t]) => t !== "apicall" && t !== "app" && t !== "component").map(([t, list]) => (
                <div key={t} className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-dim">{t === "screen" ? "pages" : t + "s"}</span>
                  <div className="flex flex-wrap gap-1">{list.slice(0, 12).map((x) => <Ref key={x.key} kind={t === "table" ? "table" : t === "endpoint" ? "endpoint" : "page"} onClick={() => select(x.key)}>{x.name}</Ref>)}{list.length > 12 && <span className="text-[11.5px] text-dim">+{list.length - 12}</span>}</div>
                </div>
              ))}
              {Object.keys(impact.data.uses).length > 0 && (
                <div className="flex flex-col gap-1 mt-1"><span className="text-[11px] uppercase tracking-wide text-dim">Depends on</span><div className="flex flex-wrap gap-1">{Object.entries(impact.data.uses).flatMap(([t, l]) => l.filter(() => t !== "apicall" && t !== "column").slice(0, 10).map((x) => <Ref key={x.key} kind={t === "table" ? "table" : t === "endpoint" ? "endpoint" : t === "external" ? "external" : "page"} onClick={() => select(x.key)}>{x.name}</Ref>))}</div></div>
              )}
            </>
          )}
        </Section>

        {node.file && project.rootPath && <SourcePeek file={node.file} from={node.lineStart} to={node.lineEnd} />}
        {extra}
      </div>
      <AddColumnModal open={addCol} onClose={() => setAddCol(false)} table={node.name} onAdd={(d) => { addDraft({ label: `add ${node.name}.${d.column}`, intent: { kind: "add_column", table: node.name, column: d.column, type: d.type, nullable: d.nullable } }); setAddCol(false); }} existing={cols.map((c) => c.name)} />
    </div>
  );
}

function ColumnDetail({ node }: { node: GNode }) {
  const a = node.attrs as { type?: string; nullable?: boolean; pk?: boolean; unique?: boolean; default?: string; references?: { table: string; column: string }; table?: string };
  return (
    <Section title="Column">
      <div className="kv"><span>type</span><span className="font-mono">{a.type}</span><span>nullable</span><span>{a.nullable ? "yes" : "no"}</span>{a.default && <><span>default</span><span className="font-mono">{a.default}</span></>}{a.pk && <><span>key</span><span>primary</span></>}{a.unique && <><span>unique</span><span>yes</span></>}{a.references && <><span>references</span><span className="font-mono text-teal">{a.references.table}.{a.references.column}</span></>}</div>
    </Section>
  );
}

export function SourcePeek({ file, from, to }: { file: string; from?: number; to?: number }) {
  const { project, openFile } = useWorkspace();
  const [open, setOpen] = useState(false);
  const src = useApi<{ lines: string[]; from: number; total: number }>(open ? `/api/projects/${project.slug}/source?file=${encodeURIComponent(file)}&from=${Math.max(1, (from || 1) - 2)}&to=${(to || (from || 1) + 40)}` : null);
  return (
    <Section title="Code" right={<span className="flex items-center gap-1"><button className="btn-ghost btn-xs" onClick={() => openFile(file, from)}>{Icon.external({ size: 12 })} Edit code</button><OpenInEditorLink file={file} line={from} /><button className="btn-subtle btn-xs" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Peek"}</button></span>}>
      <div className="text-[11px] font-mono text-dim truncate" title={file}>{file}{from ? `:${from}` : ""}</div>
      {open && (src.loading ? <Spinner /> : src.data ? <pre className="bg-bg-deep border border-border rounded-[6px] p-2.5 text-[11.5px] leading-[1.55] overflow-auto max-h-[320px] text-text-2">{src.data.lines.map((l, i) => <div key={i} className="flex gap-3"><span className="text-dim w-8 text-right flex-none select-none">{src.data!.from + i}</span><span className="whitespace-pre">{l}</span></div>)}</pre> : <div className="text-[12px] text-dim">{src.error}</div>)}
    </Section>
  );
}

export function AddColumnModal({ open, onClose, table, onAdd, existing }: { open: boolean; onClose: () => void; table: string; onAdd: (d: { column: string; type: string; nullable: boolean }) => void; existing: string[] }) {
  const [name, setName] = useState(""); const [type, setType] = useState("Text"); const [nullable, setNullable] = useState(true);
  const snake = name.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
  const dup = existing.includes(snake);
  useEffect(() => { if (open) { setName(""); setType("Text"); setNullable(true); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={<span>Add a column to <span className="font-mono">{table}</span></span>} subtitle="Drafted into a plan; nothing changes until the migration is applied." width={460} footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!snake || dup} onClick={() => onAdd({ column: snake, type, nullable })}>Add to unsaved changes</button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Column name" hint={snake && snake !== name ? `stored as ${snake}` : undefined}><input autoFocus className="input font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="full_name" /></Field>
        {dup && <div className="text-[12.5px] text-amber">{snake} already exists on {table} — link to it instead?</div>}
        <Field label="Type"><div className="flex flex-wrap gap-1.5">{TYPES.map((t) => <button key={t} onClick={() => setType(t)} className={cx("chip h-7 px-2.5 cursor-pointer", type === t ? "text-accent border-accent/50 bg-accent/10" : "text-muted border-border")}>{t}</button>)}</div></Field>
        <label className="flex items-center gap-2 text-[13px] text-text-2"><input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} /> Nullable (recommended — existing rows keep working)</label>
      </div>
    </Modal>
  );
}
