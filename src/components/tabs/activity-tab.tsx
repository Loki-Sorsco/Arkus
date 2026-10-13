"use client";
// Activity tab: every index, plan, query, connection and design step, grouped by day.
import { useMemo, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { Chip, Dot, EmptyState, Icon, Spinner, Tabs } from "@/components/ui";
import { timeAgo, useApi } from "@/lib/ui";

type A = { id: string; env: string; kind: string; what: string; meta: Record<string, unknown>; createdAt: string };
type Kind = "all" | "index" | "plan" | "query" | "write" | "connect" | "ask" | "design" | "code";
const KINDS: { id: Kind; label: string }[] = [{ id: "all", label: "All" }, { id: "index", label: "Index" }, { id: "plan", label: "Plans" }, { id: "query", label: "Queries" }, { id: "write", label: "Writes" }, { id: "connect", label: "Connect" }, { id: "ask", label: "Ask" }, { id: "design", label: "Design" }, { id: "code", label: "Code edits" }];
const DOT: Record<string, "teal" | "blue" | "purple" | "green" | "amber" | "muted"> = { index: "teal", plan: "blue", query: "purple", write: "amber", connect: "green", design: "purple", data_edit: "amber", code: "amber" };
const dayLabel = (d: string) => { const t = new Date(d), now = new Date(); const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString(); const y = new Date(now); y.setDate(now.getDate() - 1); return sameDay(t, now) ? "Today" : sameDay(t, y) ? "Yesterday" : t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: t.getFullYear() === now.getFullYear() ? undefined : "numeric" }); };

export function ActivityTab() {
  const { project, openTab } = useWorkspace();
  const [kind, setKind] = useState<Kind>("all");
  const [prodOnly, setProdOnly] = useState(false);
  const { data, loading } = useApi<A[]>(`/api/projects/${project.slug}/activity?${kind !== "all" ? `kind=${kind}&` : ""}${prodOnly ? "env=prod" : ""}`);
  const days = useMemo(() => { const m = new Map<string, A[]>(); for (const a of data || []) { const k = new Date(a.createdAt).toDateString(); if (!m.has(k)) m.set(k, []); m.get(k)!.push(a); } return [...m.values()]; }, [data]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Activity" meta={data ? `${data.length} event${data.length === 1 ? "" : "s"}` : undefined} right={<>
        {loading && <Spinner />}
        <Tabs size="sm" value={kind} onChange={setKind} items={KINDS} />
        <label className="flex items-center gap-1.5 text-[12px] text-muted cursor-pointer pl-1"><input type="checkbox" checked={prodOnly} onChange={(e) => setProdOnly(e.target.checked)} /> Prod only</label>
      </>} />
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="px-6 py-5 flex flex-col gap-4 max-w-[880px]">
          {data && !data.length ? (
            <EmptyState icon={Icon.activity()} title="Nothing here yet" hint="Indexing, plans, queries and connections show up here as you work." action={<button className="btn-primary" onClick={() => openTab({ kind: "map", label: "Map" })}>Open the map</button>} />
          ) : (
            days.map((list) => (
              <section key={list[0].id} className="flex flex-col gap-1">
                <div className="eyebrow h-7 flex items-center">{dayLabel(list[0].createdAt)}</div>
                <div className="panel">
                  {list.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 px-4 h-9 border-b border-border/60 last:border-b-0 text-[13px]">
                      <Dot color={DOT[a.kind] || "muted"} />
                      <span className="w-[72px] flex-none text-[12px] text-muted">{a.kind.replace("_", " ")}</span>
                      <span className="flex-1 min-w-0 truncate text-text-2" title={a.what}>{a.what}{typeof a.meta?.planNo === "number" && <button className="link ml-2 text-[12.5px]" onClick={() => openTab({ kind: "plans", label: "Plans", key: String(a.meta.planNo) })}>open plan</button>}</span>
                      {a.env !== "dev" && <Chip tone={a.env === "prod" ? "red" : "muted"}>{a.env}</Chip>}
                      <span className="text-[12px] text-dim whitespace-nowrap w-[72px] text-right" title={new Date(a.createdAt).toLocaleString()}>{timeAgo(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
          {loading && !data && <div className="flex items-center justify-center p-10"><Spinner /></div>}
        </div>
      </div>
    </div>
  );
}
