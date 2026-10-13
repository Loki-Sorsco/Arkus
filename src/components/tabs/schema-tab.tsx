"use client";
// Schema tab: the ER diagram full-bleed. Click selects a table (the workspace selection, so the
// Inspect pane follows); double-click a node, or "Open table", opens it as a tab.
import type { MouseEvent } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { EmptyState, Icon } from "@/components/ui";
import { timeAgo } from "@/lib/ui";
import { SchemaErd } from "@/components/screens/db-erd";
import { useDbSchema } from "@/components/screens/db-shared";
import { CenteredSpinner, ConnectEmpty, SyncButton, tableName, tableTab } from "./db-common";

export function SchemaTab({ tab }: { tab: Tab }) {
  void tab;
  const { selection, select, openTab } = useWorkspace();
  const { tables, source, snapshot, loading, reload } = useDbSchema();
  const selected = tableName(selection);
  const open = (name: string, preview = false) => openTab(tableTab(name), { preview });
  // React Flow renders each node with data-id; a double-click inside one opens that table.
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    const id = el?.dataset.id;
    if (id && tables.some((t) => t.name === id)) open(id);
  };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Schema" meta={`${tables.length} tables · ${snapshot ? `introspected ${timeAgo(snapshot.createdAt)}` : "from code"}`}
        right={<>
          <span className="text-[11.5px] text-dim hidden xl:inline">double-click a table to open it</span>
          <button className="btn-subtle btn-xs" disabled={!selected} onClick={() => selected && open(selected)} title={selected ? `Open ${selected}` : "Select a table first"}>{Icon.table({ size: 12 })} Open table</button>
          <SyncButton source={source} reload={reload} />
        </>} />
      {loading && !tables.length ? <CenteredSpinner />
        : !tables.length ? (source ? <EmptyState icon={Icon.layers()} title="No tables in this schema" hint="Sync after running your migrations." action={<SyncButton source={source} reload={reload} className="btn-ghost btn-sm" />} /> : <ConnectEmpty title="Nothing to draw yet" hint="No tables were found in the code. Connect a database to introspect its schema." onConnected={reload} />)
        : <div className="flex-1 min-h-0 relative" onDoubleClick={onDoubleClick}><SchemaErd tables={tables} selection={selection} onSelect={(n) => select(n ? `table:${n}` : null)} /></div>}
    </div>
  );
}
