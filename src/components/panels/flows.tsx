"use client";
// Flows side panel: the app as the things a user can do, grouped by kind (Sign in & accounts ·
// Actions · Browse). Click a flow → the singleton Flows tab shows its storyline. The Plain | Technical
// toggle at the bottom is shared with the tab through localStorage `arkus:explain`.
import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelSection, TreeRow } from "@/components/shell/side-panel";
import { useWorkspace } from "@/components/shell/workspace";
import { SearchInput, Spinner, Tabs } from "@/components/ui";
import { useApi, useLocal } from "@/lib/ui";
import type { Flow, FlowKind } from "@/lib/arkus/flows";

export type FlowsRes = { flows: Flow[]; ai: boolean; snapshotId: string | null };
export type Explain = "plain" | "technical";
export const FLOW_GROUPS: { label: string; kinds: FlowKind[] }[] = [
  { label: "Sign in & accounts", kinds: ["auth"] },
  { label: "Actions", kinds: ["action", "admin"] },
  { label: "Browse", kinds: ["display"] },
];
export const EXPLAIN_ITEMS: { id: Explain; label: string }[] = [{ id: "plain", label: "Plain" }, { id: "technical", label: "Technical" }];

/** Flows fetched exactly like the old page: the static list, plus the AI-named list when the project has AI. */
export function useFlows() {
  const { project } = useWorkspace();
  const base = useApi<FlowsRes>(`/api/projects/${project.slug}/flows`);
  const ai = useApi<FlowsRes>(project.ai ? `/api/projects/${project.slug}/flows?ai=1` : null);
  const flows = useMemo(() => ai.data?.flows ?? base.data?.flows ?? [], [ai.data, base.data]);
  return { flows, loading: base.loading && !base.data, snapshotId: base.data?.snapshotId ?? null };
}

/** Plain | Technical, persisted in localStorage `arkus:explain`; a window event keeps panel and tab in step. */
const EXPLAIN_EVENT = "arkus:explain";
export function useExplain() {
  const [explain, setLocal] = useLocal<Explain>("arkus:explain", "plain");
  useEffect(() => {
    const h = (e: Event) => setLocal((e as CustomEvent<Explain>).detail);
    window.addEventListener(EXPLAIN_EVENT, h);
    return () => window.removeEventListener(EXPLAIN_EVENT, h);
  }, [setLocal]);
  const set = useCallback((v: Explain) => { setLocal(v); window.dispatchEvent(new CustomEvent<Explain>(EXPLAIN_EVENT, { detail: v })); }, [setLocal]);
  return [explain, set] as const;
}

export function FlowsPanel() {
  const { openTab, activeTab } = useWorkspace();
  const { flows, loading } = useFlows();
  const [q, setQ] = useState("");
  const [explain, setExplain] = useExplain();
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const filtered = flows.filter((f) => `${f.title} ${f.page.name} ${f.summary}`.toLowerCase().includes(q.toLowerCase()));
  const groups = FLOW_GROUPS.map((g) => ({ ...g, list: filtered.filter((f) => g.kinds.includes(f.kind)) })).filter((g) => g.list.length);
  const selected = activeTab?.kind === "flows" ? activeTab.key : null;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-none px-2 py-1.5"><SearchInput value={q} onChange={setQ} placeholder="Filter flows" /></div>
      <div className="flex-1 min-h-0 overflow-auto border-t border-border">
        {groups.map((g) => (
          <PanelSection key={g.label} title={g.label} count={g.list.length} open={!closed[g.label]} onToggle={() => setClosed((c) => ({ ...c, [g.label]: !c[g.label] }))}>
            {g.list.map((f) => (
              <TreeRow key={f.id} mono={false} name={f.title} meta={<span className="font-mono">{f.page.name}</span>} title={f.summary} active={selected === f.id}
                onClick={() => openTab({ kind: "flows", label: "Flows", key: f.id })} />
            ))}
          </PanelSection>
        ))}
        {loading && <div className="p-3 flex items-center gap-2 text-[12px] text-dim"><Spinner /> Reading the map</div>}
        {!loading && !flows.length && <div className="p-3 text-[12px] text-dim">No flows found yet.</div>}
        {!!flows.length && !filtered.length && <div className="p-3 text-[12px] text-dim">No flow matches &ldquo;{q}&rdquo;.</div>}
      </div>
      <div className="flex-none border-t border-border px-2 h-9 flex items-center gap-2">
        <span className="text-[11px] text-dim flex-1 truncate">{flows.length} flow{flows.length === 1 ? "" : "s"}</span>
        <Tabs size="sm" value={explain} onChange={setExplain} items={EXPLAIN_ITEMS} />
      </div>
    </div>
  );
}
