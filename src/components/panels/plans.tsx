"use client";
// Plans side panel: every plan with its pipeline state, risk and age. Filter All / Needs review /
// Shipped. Click a plan → the singleton Plans tab (key = plan number). The list reloads whenever the
// project's plan counters change (a draft saved, a plan shipped) so it never goes stale.
import { useMemo, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, Spinner, Tabs, type Tone } from "@/components/ui";
import { cx, timeAgo, useApi } from "@/lib/ui";

export type Plan = {
  no: number; title: string; pipeline: string; risk: string; env: string; branch: string | null;
  changes: { layer: string; op: string; target: string; detail: string; file?: string; line?: number }[];
  decisions: { existingRows?: { rows: number; options: string[]; chosen: number }; suggested?: string[]; verify?: { layer: string; target: string; done: boolean }[] };
  impact: { summary?: string; risk?: string };
  checks: { name: string; status: string; evidence: string }[];
  migrationFwd: string | null; migrationRev: string | null; guide: string | null;
  comments: { at: string; text: string }[]; createdAt: string; updatedAt: string;
};
export type PlanFilter = "all" | "review" | "shipped";
export const pipelineTone = (p: string): Tone => p === "shipped" ? "green" : p === "failed" ? "red" : p === "approved" || p === "checks_passing" ? "teal" : p === "previewing" ? "amber" : "muted";
export const layerTone = (l: string): Tone => l === "DB" ? "teal" : l === "API" ? "accent" : "gold";

/** The project's plans; refetched when `project.draftPlans` / `project.plans` change. */
export function usePlans() {
  const { project } = useWorkspace();
  return useApi<Plan[]>(`/api/projects/${project.slug}/plans`, [project.draftPlans, project.plans]);
}

export function PlansPanel() {
  const { openTab, activeTab } = useWorkspace();
  const list = usePlans();
  const [filter, setFilter] = useState<PlanFilter>("all");
  const plans = useMemo(() => (list.data || []).filter((p) => filter === "all" ? true : filter === "shipped" ? p.pipeline === "shipped" : p.pipeline !== "shipped" && p.pipeline !== "failed"), [list.data, filter]);
  const selected = activeTab?.kind === "plans" ? Number(activeTab.key) : null;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-none px-2 py-1.5 border-b border-border"><Tabs size="sm" value={filter} onChange={setFilter} items={[{ id: "all", label: "All" }, { id: "review", label: "Needs review" }, { id: "shipped", label: "Shipped" }]} /></div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {plans.map((p) => (
          <div key={p.no} onClick={() => openTab({ kind: "plans", label: "Plans", key: String(p.no) })} title={p.title}
            className={cx("px-2.5 py-1.5 flex flex-col gap-0.5 cursor-pointer border-l-2 border-transparent hover:bg-surface-2", selected === p.no && "bg-surface-3 border-accent")}>
            <div className="flex items-center gap-1.5 min-w-0 text-[12.5px]"><span className="font-mono text-[11.5px] text-dim tabular-nums flex-none">#{p.no}</span><span className="truncate text-text">{p.title}</span></div>
            <div className="flex items-center gap-1.5 text-[11px] text-dim min-w-0">
              <Chip tone={pipelineTone(p.pipeline)}>{p.pipeline.replace("_", " ")}</Chip>
              {p.risk !== "low" && <span className={p.risk === "high" ? "text-red-soft" : "text-amber"}>{p.risk} risk</span>}
              <span className="ml-auto whitespace-nowrap">{timeAgo(p.updatedAt)}</span>
            </div>
          </div>
        ))}
        {list.loading && !list.data && <div className="p-3"><Spinner /></div>}
        {list.data && !plans.length && <div className="p-3 text-[12px] text-dim">{list.data.length ? "No plans match this filter." : "No plans yet."}</div>}
      </div>
      <div className="flex-none border-t border-border px-2.5 h-7 flex items-center text-[11px] text-dim">{list.data ? `${list.data.length} plan${list.data.length === 1 ? "" : "s"}` : ""}</div>
    </div>
  );
}
