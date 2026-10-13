"use client";
// History tab: timeline of schema snapshots (one Panel each, expand for the diff). Drift tab: the live
// schema vs the tables declared in code. Both are read-only views over snapshots; no live connection.
import { useState, type ReactNode } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, EmptyState, Icon, Panel, Ref, Spinner, Stat } from "@/components/ui";
import { cx, fmtNum, timeAgo, useApi } from "@/lib/ui";
import { dbBase, stageSummary, type DriftResult, type HistoryEntry, type SchemaDiff, type TableDiff } from "./db-shared";

const fieldLabel = (f: string, v: unknown) => f === "references" && v && typeof v === "object" ? `${(v as { table: string }).table}.${(v as { column: string }).column}` : v === undefined || v === null || v === "" ? "none" : String(v);

/** Added / removed / changed tables & columns as Ref chips. Shared by History and Drift. */
export function DiffDetail({ diff, leftLabel = "before", rightLabel = "after", onPick }: { diff: SchemaDiff; leftLabel?: string; rightLabel?: string; onPick?: (table: string) => void }) {
  const row = (label: ReactNode, items: ReactNode) => <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 items-start text-[13px]"><span className="text-dim pt-0.5">{label}</span><div className="flex flex-wrap gap-1.5">{items}</div></div>;
  return (
    <div className="flex flex-col gap-2.5">
      {diff.addedTables.length > 0 && row(`Only in ${rightLabel}`, diff.addedTables.map((t) => <Ref key={t} kind="table" onClick={onPick ? () => onPick(t) : undefined}>{t}</Ref>))}
      {diff.removedTables.length > 0 && row(`Only in ${leftLabel}`, diff.removedTables.map((t) => <Ref key={t} kind="unresolved">{t}</Ref>))}
      {diff.changedTables.map((t: TableDiff) => (
        <div key={t.table} className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 items-start text-[13px]">
          <span className="pt-0.5"><Ref kind="table" onClick={onPick ? () => onPick(t.table) : undefined}>{t.table}</Ref></span>
          <div className="flex flex-col gap-1">
            {t.addedColumns.length > 0 && <div className="flex flex-wrap gap-1.5 items-center"><span className="text-dim text-[12px] w-16">added</span>{t.addedColumns.map((c) => <Ref key={c.name} kind="column" className="text-green border-green/40 bg-green/10">{c.name} <span className="text-dim">{c.type}</span></Ref>)}</div>}
            {t.removedColumns.length > 0 && <div className="flex flex-wrap gap-1.5 items-center"><span className="text-dim text-[12px] w-16">removed</span>{t.removedColumns.map((c) => <Ref key={c.name} kind="unresolved">{c.name}</Ref>)}</div>}
            {t.changedColumns.map((c) => <div key={c.name} className="flex flex-wrap gap-1.5 items-center"><span className="text-dim text-[12px] w-16">changed</span><Ref kind="column">{c.name}</Ref><span className="text-[12px] text-muted">{c.fields.map((f) => `${f}: ${fieldLabel(f, c.from[f as keyof typeof c.from])} to ${fieldLabel(f, c.to[f as keyof typeof c.to])}`).join(" · ")}</span></div>)}
            {(t.addedIndexes.length > 0 || t.removedIndexes.length > 0) && <div className="flex flex-wrap gap-1.5 items-center"><span className="text-dim text-[12px] w-16">indexes</span>{t.addedIndexes.map((i, k) => <Chip key={`a${k}`} tone="green">+ {i.columns.join(", ")}{i.unique ? " (unique)" : ""}</Chip>)}{t.removedIndexes.map((i, k) => <Chip key={`r${k}`} tone="red">- {i.columns.join(", ")}{i.unique ? " (unique)" : ""}</Chip>)}</div>}
          </div>
        </div>
      ))}
      {!diff.counts.total && <div className="text-[13px] text-dim">No differences.</div>}
    </div>
  );
}

export function HistoryTab({ onPick }: { onPick: (table: string) => void }) {
  const { project, env } = useWorkspace();
  const h = useApi<{ snapshots: HistoryEntry[] }>(`${dbBase(project.slug)}/schema/history?env=${env}`);
  const [open, setOpen] = useState<string | null>(null);
  const list = h.data?.snapshots || [];
  if (h.loading && !h.data) return <div className="flex-1 flex items-center justify-center"><Spinner /></div>;
  if (!list.length) return <EmptyState icon={Icon.layers()} title="No schema snapshots yet" hint="Every connect and sync stores a snapshot of the schema, so you can see what changed over time." />;
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-bg">
      <div className="max-w-[880px] p-6 flex flex-col gap-4">
        {list.map((s, i) => {
          const d = s.diffFromPrevious;
          const expanded = open === s.id;
          return (
            <Panel key={s.id} pad={false}>
              <div className={cx("flex items-center gap-3 px-4 h-12", d && d.counts.total > 0 && "cursor-pointer hover:bg-surface-2")} onClick={() => d && d.counts.total > 0 && setOpen(expanded ? null : s.id)}>
                <span className={cx("w-2 h-2 rounded-full flex-none", i === 0 ? "bg-accent" : "bg-dim")} />
                <span className="text-[13px] font-medium">{i === 0 ? "Current schema" : timeAgo(s.createdAt)}</span>
                <span className="text-[12px] text-dim" title={`version ${s.version}`}>{i === 0 ? timeAgo(s.createdAt) + " · " : ""}{stageSummary(s.stats)}</span>
                <div className="flex-1" />
                {d ? <span className={cx("text-[12.5px]", d.counts.total ? "text-text-2" : "text-dim")}>{d.summary}</span> : <span className="text-[12.5px] text-dim">first snapshot</span>}
                {d && d.counts.total > 0 && <span className="text-dim">{Icon.chevron({ size: 14, className: cx("transition", expanded && "rotate-90") })}</span>}
              </div>
              {expanded && d && <div className="px-4 py-4 border-t border-border arise"><DiffDetail diff={d} leftLabel="previous" rightLabel="this snapshot" onPick={onPick} /></div>}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

export function DriftTab({ drift, loading, onConnect, onPick }: { drift: DriftResult | null; loading: boolean; onConnect: () => void; onPick: (table: string) => void }) {
  const { project, env } = useWorkspace();
  if (loading && !drift) return <div className="flex-1 flex items-center justify-center"><Spinner /></div>;
  if (!drift) return null;
  if (!drift.hasDb) return <EmptyState icon={Icon.db()} title={`Connect the ${env} database to check for drift`} hint="Drift compares the live schema with the tables your code declares." action={<button className="btn-primary" onClick={onConnect}>Connect database</button>} />;
  if (!drift.hasCode) return <EmptyState icon={Icon.map()} title="Index the code to check for drift" hint="Arkus needs the tables your code declares (Prisma, Drizzle, SQL migrations) to compare against." action={<a href={`/import?project=${project.slug}`} className="btn-primary">Analyse the code</a>} />;
  const d = drift.diff!;
  const rows: { kind: string; tone: "amber" | "red" | "green" | "muted"; table: string; detail: string }[] = [
    ...d.addedTables.map((t) => ({ kind: "Only in database", tone: "amber" as const, table: t, detail: "no model or migration declares this table" })),
    ...d.removedTables.map((t) => ({ kind: "Only in code", tone: "red" as const, table: t, detail: "declared in code but missing from the database" })),
    ...d.changedTables.flatMap((t) => [
      ...t.addedColumns.map((c) => ({ kind: "Column only in database", tone: "amber" as const, table: t.table, detail: `${c.name} ${c.type}` })),
      ...t.removedColumns.map((c) => ({ kind: "Column only in code", tone: "red" as const, table: t.table, detail: `${c.name} ${c.type}` })),
      ...t.changedColumns.map((c) => ({ kind: "Column differs", tone: "muted" as const, table: t.table, detail: `${c.name}: ${c.fields.map((f) => `${f} ${fieldLabel(f, c.from[f as keyof typeof c.from])} vs ${fieldLabel(f, c.to[f as keyof typeof c.to])}`).join(", ")}` })),
    ]),
  ];
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-bg">
      <div className="max-w-[880px] p-6 flex flex-col gap-4">
        <div className="flex gap-8">
          <Stat label="Only in database" value={d.counts.addedTables} tone={d.counts.addedTables ? "amber" : undefined} sub="tables" />
          <Stat label="Only in code" value={d.counts.removedTables} tone={d.counts.removedTables ? "red" : undefined} sub={`tables from ${drift.codeSource || "code"}`} />
          <Stat label="Columns differing" value={d.counts.addedColumns + d.counts.removedColumns + d.counts.changedColumns} tone={d.counts.addedColumns + d.counts.removedColumns + d.counts.changedColumns ? "amber" : undefined} sub={`across ${fmtNum(drift.tables.compared)} compared tables`} />
        </div>
        {rows.length ? (
          <Panel pad={false}>
            <table className="tbl hover">
              <thead><tr><th>Difference</th><th>Table</th><th>Detail</th></tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}><td><Chip tone={r.tone}>{r.kind}</Chip></td><td><Ref kind="table" onClick={() => onPick(r.table)}>{r.table}</Ref></td><td className="text-text-2 font-mono text-[12.5px]">{r.detail}</td></tr>)}</tbody>
            </table>
          </Panel>
        ) : <Panel><div className="text-[13px] text-text-2 flex items-center gap-2"><span className="text-green">{Icon.check({ size: 14 })}</span> The {env} database matches the {drift.codeSource || "code"} schema.</div></Panel>}
        <div className="text-[12.5px] text-dim">Drift is informational. Fix it in your migrations; Arkus never alters the database.</div>
      </div>
    </div>
  );
}
