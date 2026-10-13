"use client";
// Blueprint — tables · endpoints · pages side by side. Hover an item to see what links to it, expand a
// row to edit it inline, flip assumptions, refine in plain English, export the spec.
// Every edit becomes a new version via /refine.
import { useEffect, useState, type ReactNode } from "react";
import { Chip, Dot, Icon, MethodBadge, Panel, Spinner, Toggle, useToast } from "@/components/ui";
import { cx } from "@/lib/ui";
import {
  addColumn, addPageField, bindingCount, COLUMN_TYPES, deleteColumn, EXPORTS, epRef, K, pageEndpoints, related,
  renameColumn, renameEndpointPath, renameTable, UI_TYPES, type Blueprint, type BlueprintResp, type Issue, type ProjectRef,
} from "./blueprint-lib";

type Props = {
  project: ProjectRef;
  data: BlueprintResp;
  /** true right after the first generation: rows arise one after another */
  reveal?: boolean;
  engine?: "sqlite" | "postgresql" | "mysql";
  onUpdate: (r: BlueprintResp) => void;
  /** rendered on the right of the refine bar (e.g. "Choose infrastructure") */
  footer?: ReactNode;
};

type RefineBody = { instruction: string } | { flipAssumption: string } | { blueprint: Blueprint };

export function BlueprintView({ project, data, reveal, engine = "sqlite", onUpdate, footer }: Props) {
  const bp = data.blueprint;
  const { toast } = useToast();
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>(data.issues ?? []);
  const [refine, setRefine] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => setIssues(data.issues ?? []), [data]);

  const rel = related(bp, hover);
  const nT = bp.entities.length, nE = bp.endpoints.length, nP = bp.pages.length;
  const delay = (i: number) => (reveal ? { animationDelay: `${Math.min(i, 40) * 55}ms` } : undefined);

  const send = async (body: RefineBody, label: string) => {
    setBusy(label);
    try {
      const res = await fetch(`/api/projects/${project.id}/blueprint/refine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Partial<BlueprintResp> & { error?: string; issues?: Issue[] };
      if (res.status === 422) { setIssues(json.issues ?? []); toast({ title: "That edit doesn't validate", detail: json.issues?.[0]?.message, kind: "warn" }); return; }
      if (!res.ok || !json.blueprint) throw new Error(json.error || res.statusText);
      setIssues(json.issues ?? []);
      onUpdate(json as BlueprintResp);
      if ("instruction" in body) setRefine("");
      toast({ title: `Blueprint v${json.version}`, detail: "instruction" in body && !json.aiUsed ? "AI is offline — the request was recorded as an assumption to apply manually." : undefined, kind: "ok" });
    } catch (e) { toast({ title: "Refine failed", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  };
  const edit = (next: Blueprint) => { if (next !== bp) send({ blueprint: next }, "edit"); };
  const exportUrl = (f: string) => `/api/projects/${project.id}/blueprint/export?format=${f}&engine=${f === "sql" ? (engine === "sqlite" ? "sqlite" : "postgres") : engine}&download=1`;

  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const itemCls = (key: string) => cx("border-b border-border/60 last:border-b-0 transition-opacity duration-150", reveal && "arise", rel && !rel.has(key) && "opacity-30");
  const rowCls = (key: string) => cx("list-row", (open[key] || hover === key) && "active");
  const hov = (key: string) => ({ onMouseEnter: () => setHover(key), onMouseLeave: () => setHover(null) });
  const failing = data.checks?.filter((c) => !c.ok).length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* summary row */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold truncate">{bp.name}</div>
          <div className="text-[12.5px] text-muted flex items-center gap-2 flex-wrap">
            <span>v{data.version} · {nT} tables · {nE} endpoints · {nP} pages · {data.aiUsed ? "designed by AI" : `from the ${data.template ? data.template.replace(/[-_]/g, " ") : "offline"} template`}</span>
            {busy && <span className="flex items-center gap-1.5"><Spinner /> {busy === "edit" ? "saving" : busy === "refine" ? "refining" : "flipping"}</span>}
          </div>
        </div>
        {!data.aiUsed && <Chip tone="muted" title="Add a Groq key under Settings → AI and regenerate for an AI-designed blueprint">AI offline</Chip>}
        <div className="relative">
          <button className="btn-ghost btn-sm" onClick={() => setExportOpen((o) => !o)}>Export <span className="rotate-90 inline-flex">{Icon.chevron({ size: 12 })}</span></button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-[40]" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 top-9 z-[41] card arise shadow-[0_12px_32px_rgba(0,0,0,.45)] w-[240px] p-1">
                {EXPORTS.map(([f, label, file]) => (
                  <button key={f} className="w-full flex items-center justify-between px-2.5 h-8 rounded-[5px] text-[13px] text-text-2 hover:bg-surface-3 hover:text-text cursor-pointer" onClick={() => { window.open(exportUrl(f), "_blank", "noopener"); setExportOpen(false); }}>
                    <span>{label}</span><span className="font-mono text-[11px] text-dim">{file}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {issues.length > 0 && (
        <div className="text-[12.5px] rounded-[6px] border border-amber/40 bg-amber/10 px-3 py-2 flex flex-col gap-0.5">
          {issues.slice(0, 8).map((i, n) => <div key={n} className={i.level === "error" ? "text-red-soft" : "text-amber"}><span className="font-mono text-dim">{i.where}</span> — {i.message}</div>)}
          {issues.length > 8 && <span className="text-dim">+{issues.length - 8} more</span>}
        </div>
      )}

      {/* three columns */}
      <div className="grid grid-cols-3 gap-4 items-start">
        <Panel title="Tables" right={<span className="text-dim text-[12px] tabular-nums font-normal">{nT}</span>} icon={<Dot color="teal" />} pad={false}>
          <div className="max-h-[560px] overflow-auto">
            {bp.entities.map((e, i) => {
              const key = K.t(e.table);
              return (
                <div key={e.table} className={itemCls(key)} style={delay(i)} {...hov(key)}>
                  <div className={rowCls(key)} onClick={() => toggle(key)}>
                    <span className="font-mono text-text truncate">{e.table}</span>
                    <span className="ml-auto text-[11.5px] text-dim tabular-nums whitespace-nowrap">{e.columns.length} col{e.columns.length === 1 ? "" : "s"}</span>
                    <span className={cx("text-dim transition", open[key] && "rotate-90")}>{Icon.chevron({ size: 12 })}</span>
                  </div>
                  {open[key] && (
                    <div className="px-3 pb-3 pt-1 flex flex-col gap-2 bg-bg-deep/30">
                      <div className="flex items-center gap-2 text-[12px] text-muted"><InlineText className="font-mono text-text-2" value={e.table} onCommit={(v) => edit(renameTable(bp, e.table, v))} /><span className="text-dim">click to rename</span></div>
                      {e.description && <div className="text-[12px] text-muted leading-snug">{e.description}</div>}
                      <div className="flex flex-col">
                        {e.columns.map((c) => (
                          <div key={c.name} className="group flex items-center gap-2 h-7 text-[12.5px]">
                            <InlineText className="font-mono text-text-2" value={c.name} onCommit={(v) => edit(renameColumn(bp, e.table, c.name, v))} />
                            <span className="font-mono text-[11.5px] text-dim">{c.type}{c.nullable ? "?" : ""}</span>
                            {c.pk && <span className="text-[10.5px] text-dim uppercase tracking-wide" title="primary key">pk</span>}
                            {c.references && <span className="text-[10.5px] text-teal uppercase tracking-wide" title={`references ${c.references.table}.${c.references.column}`}>fk</span>}
                            {c.unique && !c.pk && <span className="text-[10.5px] text-dim uppercase tracking-wide">unique</span>}
                            <button className="ml-auto opacity-0 group-hover:opacity-100 text-dim hover:text-red-soft cursor-pointer" title="delete column" onClick={() => edit(deleteColumn(bp, e.table, c.name))}>{Icon.close({ size: 12 })}</button>
                          </div>
                        ))}
                      </div>
                      <AddRow label="Add column" placeholder="column name" options={COLUMN_TYPES} onAdd={(n, t) => edit(addColumn(bp, e.table, n, t))} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Endpoints" right={<span className="text-dim text-[12px] tabular-nums font-normal">{nE}</span>} icon={<Dot color="accent" />} pad={false}>
          <div className="max-h-[560px] overflow-auto">
            {bp.endpoints.map((ep, i) => {
              const ref = epRef(ep); const key = K.e(ref);
              return (
                <div key={ref} className={itemCls(key)} style={delay(nT + i)} {...hov(key)}>
                  <div className={rowCls(key)} onClick={() => toggle(key)}>
                    <MethodBadge method={ep.method} className="w-[48px] text-[10.5px] h-[18px]" />
                    <span className="font-mono text-[12.5px] text-text truncate">{ep.path}</span>
                    {!ep.auth && <span className="ml-auto text-[11px] text-amber whitespace-nowrap">public</span>}
                    <span className={cx("text-dim transition", !ep.auth ? "" : "ml-auto", open[key] && "rotate-90")}>{Icon.chevron({ size: 12 })}</span>
                  </div>
                  {open[key] && (
                    <div className="px-3 pb-3 pt-1 flex flex-col gap-2 bg-bg-deep/30 text-[12.5px]">
                      <div className="flex items-center gap-2 text-[12px] text-muted"><InlineText className="font-mono text-text-2" value={ep.path} onCommit={(v) => edit(renameEndpointPath(bp, ref, v))} /><span className="text-dim">click to rename</span></div>
                      <div className="text-muted leading-snug">{ep.name}{ep.description ? ` — ${ep.description}` : ""}</div>
                      {ep.request.length > 0 && <div className="kv text-[12px]"><span>request</span><span className="font-mono text-text-2 break-words">{ep.request.map((r) => `${r.key}${r.required ? "" : "?"}`).join(", ")}</span></div>}
                      {(ep.reads.length > 0 || ep.writes.length > 0) && (
                        <div className="kv text-[12px]">
                          {ep.reads.length > 0 && <><span>reads</span><span className="font-mono text-teal">{ep.reads.join(", ")}</span></>}
                          {ep.writes.length > 0 && <><span>writes</span><span className="font-mono text-teal">{ep.writes.join(", ")}</span></>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Pages" right={<span className="text-dim text-[12px] tabular-nums font-normal">{nP}</span>} icon={<Dot color="gold" />} pad={false}>
          <div className="max-h-[560px] overflow-auto">
            {bp.pages.map((p, i) => {
              const key = K.p(p.path); const eps = pageEndpoints(p);
              return (
                <div key={p.path} className={itemCls(key)} style={delay(nT + nE + i)} {...hov(key)}>
                  <div className={rowCls(key)} onClick={() => toggle(key)}>
                    <span className="font-mono text-text truncate">{p.path}</span>
                    <span className="ml-auto text-[11.5px] text-dim whitespace-nowrap">{p.fields.length ? `form · ${p.fields.length}` : p.kind}</span>
                    <span className={cx("text-dim transition", open[key] && "rotate-90")}>{Icon.chevron({ size: 12 })}</span>
                  </div>
                  {open[key] && (
                    <div className="px-3 pb-3 pt-1 flex flex-col gap-2 bg-bg-deep/30 text-[12.5px]">
                      <div className="text-muted">{p.name} · {p.kind}</div>
                      {p.fields.length > 0 && (
                        <div className="flex flex-col">
                          {p.fields.map((f) => (
                            <div key={f.key} className="flex items-center gap-2 h-7" title={[f.endpoint && `→ ${f.endpoint}`, f.column && `→ ${f.column}`].filter(Boolean).join("  ")}>
                              <span className="text-text-2 truncate">{f.label}</span><span className="font-mono text-[11px] text-dim">{f.uiType}{f.required ? " · required" : ""}</span>
                              {f.column && <span className="ml-auto font-mono text-[11px] text-teal truncate">{f.column}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      {eps.length > 0 && (
                        <div className="flex flex-col gap-1 pt-1 border-t border-border/60">
                          {eps.map((ref) => { const [m, path] = ref.split(" "); return <div key={ref} className="flex items-center gap-1.5 text-[11.5px]"><span className="text-dim">calls</span><MethodBadge method={m} className="w-[48px] text-[10.5px] h-[18px]" /><span className="font-mono text-text-2 truncate">{path}</span></div>; })}
                        </div>
                      )}
                      <AddRow label="Add field" placeholder="field label" options={UI_TYPES} onAdd={(n, t) => edit(addPageField(bp, p.path, n, t))} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* checks + assumptions */}
      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Checks" right={(data.checks?.length ?? 0) > 0 ? <Chip tone={failing ? "amber" : "green"}>{failing ? `${failing} to review` : "all passing"}</Chip> : undefined} pad={false}>
          {(data.checks?.length ?? 0) > 0 ? data.checks.map((c) => (
            <div key={c.name} className="flex items-start gap-2.5 px-4 py-2 border-b border-border/60 last:border-b-0 text-[13px]"><Dot color={c.ok ? "green" : "red"} className="mt-[7px]" /><div className="min-w-0"><div className="text-text-2">{c.name}</div>{c.detail && <div className="text-[12px] text-dim">{c.detail}</div>}</div></div>
          )) : <div className="px-4 py-3 text-[12.5px] text-dim">No checks recorded for this version.</div>}
        </Panel>
        <Panel title="Assumptions" right={bp.assumptions.length ? <span className="text-[12px] text-dim font-normal">switch one off to use the alternative</span> : undefined} pad={false}>
          {bp.assumptions.length ? bp.assumptions.map((a) => (
            <div key={a.id} className={cx("px-4 py-2.5 border-b border-border/60 last:border-b-0", busy && "pointer-events-none opacity-60")}>
              <Toggle checked={a.chosen} onChange={() => send({ flipAssumption: a.id }, "flip")} label={a.text} hint={a.alternative ? `Alternative: ${a.alternative}` : undefined} />
            </div>
          )) : <div className="px-4 py-3 text-[12.5px] text-dim">No assumptions were made.</div>}
        </Panel>
      </div>

      {/* refine */}
      <Panel title="Refine" right={<span className="text-[12px] text-dim font-normal">{bindingCount(bp)} bindings · nothing is built yet</span>}>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (refine.trim().length >= 2 && !busy) send({ instruction: refine.trim() }, "refine"); }}>
          <input className="input flex-1" value={refine} onChange={(e) => setRefine(e.target.value)} placeholder={`Describe a change in plain English, e.g. "Add a waitlist" or "drop the ${bp.entities[bp.entities.length - 1]?.table ?? "last"} table"`} disabled={!!busy} />
          <button className="btn-ghost" type="submit" disabled={!!busy || refine.trim().length < 2}>{busy === "refine" ? <Spinner /> : "Refine"}</button>
          {footer && <><div className="w-px h-7 bg-border mx-1" />{footer}</>}
        </form>
      </Panel>
    </div>
  );
}

// ---------- atoms ----------
/** Click-to-edit text. Enter/blur commits, Esc cancels. */
function InlineText({ value, onCommit, className }: { value: string; onCommit: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { setEditing(false); if (v.trim() && v.trim() !== value) onCommit(v.trim()); else setV(value); };
  if (!editing) return <span className={cx("cursor-text rounded-[3px] hover:bg-surface-3 px-0.5 -mx-0.5", className)} title="click to rename" onClick={() => setEditing(true)}>{value}</span>;
  return <input autoFocus className={cx("bg-bg border border-accent rounded-[4px] px-1 h-6 outline-none min-w-0 w-[160px]", className)} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setV(value); setEditing(false); } }} />;
}

/** "Add column" / "Add field": a collapsed button that expands into name + type → Add. */
function AddRow({ label, placeholder, options, onAdd }: { label: string; placeholder: string; options: readonly string[]; onAdd: (name: string, type: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>(options[0]);
  if (!open) return <button className="btn-subtle btn-xs self-start" onClick={() => setOpen(true)}>{Icon.plus({ size: 12 })} {label}</button>;
  const submit = () => { if (name.trim()) onAdd(name.trim(), type); setName(""); setOpen(false); };
  return (
    <form className="flex items-center gap-1 mt-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input autoFocus className="input input-sm flex-1 min-w-0" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
      <select className="select input-sm w-[112px]" value={type} onChange={(e) => setType(e.target.value)}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
      <button type="submit" className="btn-primary btn-sm">Add</button>
      <button type="button" className="btn-icon btn-sm" onClick={() => setOpen(false)} aria-label="Cancel">{Icon.close({ size: 13 })}</button>
    </form>
  );
}
