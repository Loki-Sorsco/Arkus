"use client";
// Shared vocabulary for the Database + Connections screens: API shapes, hooks (sources, schema),
// a status-tolerant POST helper, cell formatting, lock chips, CSV export and the results table.
import { useMemo, type ReactNode } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, Icon } from "@/components/ui";
import { cx, useApi } from "@/lib/ui";

// ---------- types (mirror the API) ----------
export type Engine = "postgres" | "mysql" | "sqlite";
export type DbColumn = { name: string; type: string; nullable?: boolean; pk?: boolean; unique?: boolean; default?: string; references?: { table: string; column: string }; index?: boolean; secret?: boolean; pii?: boolean };
export type DbTable = { name: string; rowEstimate: number | null; indexes: { name?: string; columns: string[]; unique?: boolean }[]; columns: DbColumn[] };
export type TablesResp = { env: string; engine: string | null; snapshot: { id: string; version: string; createdAt: string } | null; tables: DbTable[] };
export type SnapshotStats = { tables?: number; columns?: number; fks?: number; indexes?: number; viewsSkipped?: number; engineVersion?: string };
export type PublicSnapshot = { id: string; version: string; createdAt: string; stats: SnapshotStats };
export type PublicSource = { id: string; name: string; env: string; kind: string; engine: Engine | null; display: string; schemaOnly: boolean; status: string; testedAt: string | null; lastError: string | null; local: boolean; database?: string; host?: string; snapshot: PublicSnapshot | null };
export type TestStage = { name: string; ok: boolean; ms: number; error?: string };
export type TestResult = { ok: boolean; engine?: Engine; display?: string; local?: boolean; stages: TestStage[]; tableCount?: number; version?: string; error?: string; source?: PublicSource };
export type ColumnChange = { name: string; from: Partial<DbColumn>; to: Partial<DbColumn>; fields: string[] };
export type TableDiff = { table: string; addedColumns: DbColumn[]; removedColumns: DbColumn[]; changedColumns: ColumnChange[]; addedIndexes: DbTable["indexes"]; removedIndexes: DbTable["indexes"] };
export type SchemaDiff = { addedTables: string[]; removedTables: string[]; changedTables: TableDiff[]; summary: string; counts: { addedTables: number; removedTables: number; changedTables: number; addedColumns: number; removedColumns: number; changedColumns: number; addedIndexes: number; removedIndexes: number; total: number } };
export type DriftResult = { env: string; hasCode: boolean; hasDb: boolean; codeSource: string | null; snapshotIds: { code: string | null; schema: string | null }; tables: { db: number; code: number; compared: number }; diff: SchemaDiff | null };
export type HistoryEntry = { id: string; version: string; createdAt: string; stats: SnapshotStats; previousId: string | null; diffFromPrevious: SchemaDiff | null };
export type SyncResp = { ok: boolean; snapshot?: { id: string; version: string; stats: SnapshotStats }; diff?: SchemaDiff; reused?: boolean; source?: PublicSource; error?: string };
export type ConnectResp = { ok: boolean; source?: PublicSource; snapshot?: { id: string; version: string; reused: boolean; stats: SnapshotStats } | null; test?: TestResult; error?: string };
export type SavedQuery = { id: string; env: string; question: string | null; sql: string; status: string; rows: number; ms: number; saved: boolean; name: string | null; createdAt: string };
export type FilterOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "like" | "is null" | "not null";
export type Filter = { column: string; op: FilterOp; value?: string };
export type Row = Record<string, unknown>;

export const ENGINES: { id: Engine; label: string; placeholder: string; stages: string[] }[] = [
  { id: "postgres", label: "Postgres", placeholder: "postgres://user:password@host:5432/database", stages: ["DNS", "TCP", "Auth", "Introspect"] },
  { id: "mysql", label: "MySQL / MariaDB", placeholder: "mysql://user:password@host:3306/database", stages: ["DNS", "TCP", "Auth", "Introspect"] },
  { id: "sqlite", label: "SQLite", placeholder: "file:./prisma/dev.db", stages: ["File", "Open", "Introspect"] },
];
export const engineLabel = (e: string | null | undefined) => ENGINES.find((x) => x.id === e)?.label || e || "database";

export const OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: "=", label: "=", needsValue: true }, { op: "!=", label: "!=", needsValue: true }, { op: ">", label: ">", needsValue: true }, { op: "<", label: "<", needsValue: true },
  { op: ">=", label: ">=", needsValue: true }, { op: "<=", label: "<=", needsValue: true }, { op: "like", label: "like", needsValue: true }, { op: "is null", label: "is null", needsValue: false }, { op: "not null", label: "not null", needsValue: false },
];
export const opLabel = (op: FilterOp) => OPS.find((o) => o.op === op)?.label || op;

/** db routes resolve slug-or-id; the slug is what the workspace knows. */
export const dbBase = (slug: string) => `/api/projects/${slug}/db`;

/** Like api() but returns the JSON body on every status: the db routes answer 422/403/500 with
 * `{ ok:false, reason|blocked|stages }` rather than `{ error }`, which api() would flatten. */
export async function post<T = Record<string, unknown>>(url: string, json?: unknown, method = "POST"): Promise<T & { status: number }> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  return { ...(data as T), status: res.status };
}

/** All db sources of the project (one per env) with their latest schema snapshot. */
export function useDbSources() {
  const { project } = useWorkspace();
  const r = useApi<{ sources: PublicSource[] }>(`${dbBase(project.slug)}/sources`);
  const sources = useMemo(() => r.data?.sources ?? [], [r.data]);
  return { sources, byEnv: (env: string) => sources.find((s) => s.env === env) ?? null, loading: r.loading, error: r.error, reload: () => r.reload(true) };
}

/** Tables for the current env: the introspected snapshot when a database is connected, else the
 * tables the code analysis found (columns from Prisma / Drizzle / SQL). */
export function useDbSchema() {
  const { project, env, graph } = useWorkspace();
  const t = useApi<TablesResp>(`${dbBase(project.slug)}/tables?env=${env}`);
  const src = useDbSources();
  const source = src.byEnv(env);
  const fromDb = (t.data?.tables.length || 0) > 0;
  const tables = useMemo<DbTable[]>(() => {
    if (fromDb) return t.data!.tables;
    return (graph?.nodes || []).filter((n) => n.type === "table").map((n) => ({
      name: n.name, rowEstimate: (n.attrs?.rowEstimate as number | undefined) ?? null,
      indexes: (n.attrs?.indexes as DbTable["indexes"] | undefined) || [],
      columns: ((n.attrs?.columns as DbColumn[] | undefined) || []).map((c) => ({ ...c, secret: false, pii: false })),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }, [fromDb, t.data, graph]);
  return {
    tables, fromDb, engine: t.data?.engine || source?.engine || project.stack?.dbEngineHint || null,
    snapshot: t.data?.snapshot || null, source, sources: src.sources, schemaOnly: !!source?.schemaOnly,
    loading: t.loading || src.loading, error: t.error || src.error,
    reload: async () => { await Promise.all([t.reload(true), src.reload()]); },
  };
}

export const quoteId = (engine: string | null | undefined, name: string) => (engine === "mysql" ? `\`${name}\`` : `"${name}"`);
export const param = (engine: string | null | undefined, i: number) => (engine === "postgres" || !engine ? `$${i}` : "?");

export function fmtCell(v: unknown): { text: string; tone: "dim" | "normal" | "mono" } {
  if (v === null || v === undefined) return { text: "null", tone: "dim" };
  if (typeof v === "boolean") return { text: v ? "true" : "false", tone: "mono" };
  if (typeof v === "number" || typeof v === "bigint") return { text: String(v), tone: "mono" };
  if (v instanceof Date) return { text: v.toISOString(), tone: "mono" };
  if (typeof v === "object") { const s = JSON.stringify(v); return { text: s.length > 80 ? s.slice(0, 77) + "..." : s, tone: "mono" }; }
  const s = String(v);
  return { text: s.length > 120 ? s.slice(0, 117) + "..." : s, tone: "normal" };
}

/** Lock marker for masked / withheld columns (icon only; the explanation lives in the title). */
export const LockMark = ({ kind, label }: { kind: "masked" | "hidden"; label?: boolean }) => (
  <span className={cx("inline-flex items-center gap-1", kind === "hidden" ? "text-red-soft" : "text-amber")} title={kind === "hidden" ? "Never returned: secret-like column, withheld by the read guard." : "Masked: personal data is partially hidden before it leaves the database."}>
    {Icon.lock({ size: 12 })}{label && <span className="text-[11px]">{kind === "hidden" ? "hidden" : "masked"}</span>}
  </span>
);
export const LockChip = ({ kind, count }: { kind: "masked" | "hidden"; count?: number }) => (
  <Chip tone={kind === "hidden" ? "red" : "amber"} title={kind === "hidden" ? "Never returned: secret-like columns are withheld by the read guard." : "Masked: personal data is partially hidden before it leaves the database."}>{Icon.lock({ size: 11 })} {count != null ? `${count} ` : ""}{kind}</Chip>
);

/** Short dim line under a PageHeader for secondary status (time, version, env). Local primitive. */
export const StatusLine = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx("flex-none h-8 flex items-center gap-2 px-6 text-[12px] text-dim border-b border-border bg-surface", className)}>{children}</div>
);

export const stageSummary = (stats: SnapshotStats | undefined | null) => stats ? `${(stats.tables ?? 0).toLocaleString()} tables · ${(stats.columns ?? 0).toLocaleString()} columns · ${(stats.fks ?? 0).toLocaleString()} FKs` : "no schema yet";

export function exportRows(rows: Row[], columns: string[], format: "csv" | "json", name: string) {
  let text: string, type: string;
  if (format === "json") { text = JSON.stringify(rows, null, 2); type = "application/json"; }
  else {
    const esc = (v: unknown) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    text = [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n"); type = "text/csv";
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = `${name.replace(/[^\w.-]+/g, "_")}.${format}`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Secret-like column names (mirrors the server's SECRET_RE in browse.ts): never shown, never written. */
export const SECRET_RE = /(^|_)(password|passwd|pwd|token|secret|hash|api_?key|private_?key|access_?key|refresh_?token|salt|otp)(_|$)/i;
export const isSecretName = (name: string) => SECRET_RE.test(name) || SECRET_RE.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

/** Results table shared by the data grid and the query runner. Sticky header, mono identifiers.
 * Optional hooks let the data grid make cells click-to-edit (`onCellClick`, `cellProps`, `renderCell`
 * with the row index), tint whole rows (`rowClass`), prepend staged rows (`before`) and append a trailing
 * per-row actions cell (`rowActions`). */
export function ResultsTable({ columns, rows, masked, hidden, sort, onSort, renderCell, onCellClick, cellProps, rowActions, rowClass, before, colMeta }: {
  columns: string[]; rows: Row[]; masked: string[]; hidden: string[];
  sort?: { column: string; dir: "asc" | "desc" } | null; onSort?: (c: string) => void;
  renderCell?: (col: string, v: unknown, row: Row, rowIdx: number) => ReactNode;
  onCellClick?: (col: string, row: Row, rowIdx: number) => void;
  cellProps?: (col: string, row: Row, rowIdx: number) => { className?: string; title?: string } | undefined;
  rowActions?: (row: Row, rowIdx: number) => ReactNode;
  /** extra classes for a whole row (staged delete tint, strikethrough) */
  rowClass?: (row: Row, rowIdx: number) => string | undefined;
  /** `<tr>` elements rendered above the fetched rows (staged inserts) */
  before?: ReactNode;
  colMeta?: Record<string, DbColumn>;
}) {
  const all = [...columns, ...hidden];
  return (
    <table className="text-[13px] border-collapse min-w-full">
      <thead className="sticky top-0 z-10 bg-surface">
        <tr>
          <th className="text-left text-[11px] font-semibold text-dim px-3 h-9 border-b border-border w-10">#</th>
          {all.map((c) => {
            const m = colMeta?.[c]; const isHidden = hidden.includes(c); const isMasked = masked.includes(c);
            return (
              <th key={c} onClick={() => !isHidden && onSort?.(c)} className={cx("text-left font-medium px-3 h-9 border-b border-border whitespace-nowrap", onSort && !isHidden && "cursor-pointer hover:bg-surface-2")} title={m ? `${c} ${m.type}${m.nullable ? " null" : ""}${m.pk ? " · primary key" : m.references ? ` · references ${m.references.table}.${m.references.column}` : ""}${onSort && !isHidden ? " · click to sort" : ""}` : undefined}>
                <div className="flex items-center gap-1.5">
                  <span className={cx("font-mono text-[12.5px]", isHidden ? "text-dim line-through" : "text-text")}>{c}</span>
                  {m?.pk && <span className="text-[10px] text-dim">PK</span>}
                  {sort?.column === c && <span className="text-accent">{Icon.chevron({ size: 11, className: sort.dir === "asc" ? "-rotate-90" : "rotate-90" })}</span>}
                  {isHidden ? <LockMark kind="hidden" /> : isMasked ? <LockMark kind="masked" /> : null}
                </div>
              </th>
            );
          })}
          {rowActions && <th className="h-9 border-b border-border w-10" aria-label="Row actions" />}
        </tr>
      </thead>
      <tbody>
        {before}
        {rows.map((r, i) => (
          <tr key={i} className={cx("hover:bg-surface-2 group", rowClass?.(r, i))}>
            <td className="px-3 h-9 text-dim text-[11px] border-b border-border/60 font-mono select-none">{i + 1}</td>
            {all.map((c) => {
              if (hidden.includes(c)) return <td key={c} className="px-3 h-9 border-b border-border/60 text-dim font-mono" title="never returned">****</td>;
              const f = fmtCell(r[c]);
              const extra = cellProps?.(c, r, i);
              const longText = typeof r[c] === "string" && (r[c] as string).length > 120 ? (r[c] as string) : undefined;
              return (
                <td key={c} onClick={onCellClick ? () => onCellClick(c, r, i) : undefined} className={cx("px-3 h-9 border-b border-border/60 whitespace-nowrap max-w-[360px] overflow-hidden text-ellipsis", f.tone === "dim" ? "text-dim" : f.tone === "mono" ? "font-mono text-text-2" : "text-text-2", extra?.className)} title={extra?.title ?? longText}>
                  {renderCell ? renderCell(c, r[c], r, i) : f.text}
                </td>
              );
            })}
            {rowActions && <td className="px-2 h-9 border-b border-border/60 whitespace-nowrap text-right">{rowActions(r, i)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
