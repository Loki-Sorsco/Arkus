"use client";
// Schema history tab: the snapshot timeline from the Database screens; table refs open table tabs.
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { HistoryTab as HistoryView } from "@/components/screens/db-history";
import { useDbSchema } from "@/components/screens/db-shared";
import { SyncButton, tableTab } from "./db-common";

export function HistoryTab({ tab }: { tab: Tab }) {
  void tab;
  const { env, openTab } = useWorkspace();
  const { source, reload } = useDbSchema();
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Schema history" meta={`${env} · one snapshot per connect or sync`} right={<SyncButton source={source} reload={reload} />} />
      <HistoryView key={`${env}:${source?.snapshot?.id ?? ""}`} onPick={(t) => openTab(tableTab(t), { preview: true })} />
    </div>
  );
}
