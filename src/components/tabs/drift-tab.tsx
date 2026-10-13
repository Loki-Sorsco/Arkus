"use client";
// Drift tab: live schema vs the tables declared in code, for the current env. Connect opens the
// connect dialog; table refs open table tabs; Refresh re-fetches (Sync re-introspects first).
import { useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { Chip, Icon, Spinner } from "@/components/ui";
import { DriftTab as DriftView } from "@/components/screens/db-history";
import { ConnectDbModal } from "@/components/screens/db-connect";
import { useDbSchema } from "@/components/screens/db-shared";
import { SyncButton, tableTab, useDrift } from "./db-common";

export function DriftTab({ tab }: { tab: Tab }) {
  void tab;
  const { env, openTab } = useWorkspace();
  const { source, reload } = useDbSchema();
  const { drift, loading, count, reload: refetch } = useDrift();
  const [connect, setConnect] = useState(false);
  const status = !drift ? null : !drift.hasDb ? "no database" : !drift.hasCode ? "code not indexed" : count ? `${count} difference${count > 1 ? "s" : ""}` : "in sync";
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Drift" meta={<>{env}{drift?.codeSource ? ` · code: ${drift.codeSource}` : ""}</>}
        right={<>
          {status && <Chip tone={count ? "amber" : drift?.hasDb && drift?.hasCode ? "green" : "muted"}>{status}</Chip>}
          <button className="btn-icon btn-xs" disabled={loading} onClick={refetch} title="Refresh" aria-label="Refresh">{loading ? <Spinner /> : Icon.refresh({ size: 13 })}</button>
          <SyncButton source={source} reload={async () => { await reload(); await refetch(); }} />
        </>} />
      <DriftView drift={drift} loading={loading} onConnect={() => setConnect(true)} onPick={(t) => openTab(tableTab(t), { preview: true })} />
      <ConnectDbModal open={connect} onClose={() => setConnect(false)} env={env} existing={source} onConnected={async () => { setConnect(false); await reload(); await refetch(); }} />
    </div>
  );
}
