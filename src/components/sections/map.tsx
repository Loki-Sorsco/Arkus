"use client";
// Map: the whole app as lanes (pages → APIs → tables → services). Click a card to light up what it
// touches and inspect it; double-click to open it in its section; Blast radius shows what breaks.
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArchitectureMap, blastRadius } from "@/components/screens/map";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { EmptyState, Icon, SearchInput, Spinner, Tabs } from "@/components/ui";
import { cx, timeAgo, useLocal } from "@/lib/ui";

export function MapSection() {
  const { project, graph, graphLoading, selection, select, openNode } = useWorkspace();
  const [layer, setLayer] = useState<"all" | "pages" | "apis" | "db">("all");
  const [filter, setFilter] = useState("");
  const [blast, setBlast] = useState(false);
  const [hintSeen, setHintSeen] = useLocal<boolean>("arkus:map-hint2", false);
  const empty = !graphLoading && (!graph || !graph.snapshotId);
  const sel = graph?.nodes.find((n) => n.key === selection) || null;
  const blastOn = blast && !!sel;
  const impacted = useMemo(() => (blastOn && graph && selection ? [...blastRadius(graph, selection)].filter((k) => /^(screen|endpoint|table|external):/.test(k)) : []), [blastOn, graph, selection]);
  const n = (p: string) => impacted.filter((k) => k.startsWith(p)).length;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Map" right={<>
        {graph?.createdAt && <span className="text-[11px] text-dim whitespace-nowrap hidden xl:inline">indexed {timeAgo(graph.createdAt)}</span>}
        {project.rootPath && <Link href={`/import?project=${project.slug}`} className="btn-subtle btn-xs whitespace-nowrap" title="Read the code again">{Icon.refresh({ size: 12 })} Re-index</Link>}
      </>}>
        <SearchInput value={filter} onChange={setFilter} placeholder="Find…" className="w-[160px] flex-none" />
        <Tabs size="sm" value={layer} onChange={setLayer} items={[{ id: "all", label: "All" }, { id: "pages", label: "Pages" }, { id: "apis", label: "APIs" }, { id: "db", label: "Data" }]} />
        <button className={cx("btn-xs", blastOn ? "btn-danger" : "btn-ghost")} disabled={!sel} title={sel ? "Show everything that depends on the selected card" : "Select a card first"} onClick={() => setBlast((b) => !b)}>{Icon.bolt({ size: 12 })} Blast radius</button>
        {blastOn && <span className="text-[11.5px] text-red-soft whitespace-nowrap">{impacted.length ? `${n("screen:")} pages · ${n("endpoint:")} APIs · ${n("table:")} tables would be affected` : "nothing else depends on this"}</span>}
      </TabToolbar>
      {graph?.snapshotId && !hintSeen && (
        <div className="flex-none flex items-center gap-3 px-3 h-8 border-b border-border bg-surface-2 text-[12px] text-text-2 arise">
          <span className="text-accent">{Icon.bolt({ size: 13 })}</span>
          <span className="truncate">Pages call APIs, APIs read and write tables. Click a card to see what it touches; double-click to open it.</span>
          <button className="btn-subtle btn-xs ml-auto" onClick={() => setHintSeen(true)}>Got it</button>
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {graphLoading && <div className="absolute inset-0 flex items-center justify-center"><Spinner /></div>}
        {empty && (project.mode === "designed"
          ? <EmptyState icon={Icon.spark()} title="This project is still a blueprint" hint="Open the architect to design tables, APIs and pages, then scaffold a repo to turn it into a connected project." action={<Link href={`/new?project=${project.slug}`} className="btn-primary">Open the blueprint</Link>} />
          : <EmptyState icon={Icon.map()} title="No map yet" hint="Run the analysis to read the code and build the map." action={<Link href={`/import?project=${project.slug}`} className="btn-primary">Analyse the code</Link>} />)}
        {graph?.snapshotId && <ArchitectureMap graph={graph} selection={selection} onSelect={(k) => select(k)} onOpen={(k) => openNode(k)} layer={layer} filter={filter} density="auto" blast={blastOn} />}
        {graph?.snapshotId && (
          <div className="absolute left-3 bottom-3 flex items-center gap-3 text-[10.5px] text-muted bg-surface/90 border border-border rounded-[6px] px-2.5 h-6 backdrop-blur pointer-events-none">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gold" />page</span><span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue" />API</span><span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-teal" />table</span><span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple" />service</span>
          </div>
        )}
      </div>
    </div>
  );
}
