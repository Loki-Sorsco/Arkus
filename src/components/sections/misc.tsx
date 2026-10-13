"use client";
// The non-core screens, reached from the rail's More menu: Flows, Plans, Activity, Connections, Settings.
import { ListPane, useWorkspace } from "@/components/shell/workspace";
import { FlowsPanel } from "@/components/panels/flows";
import { PlansPanel } from "@/components/panels/plans";
import { FlowsTab } from "@/components/tabs/flows-tab";
import { PlansTab } from "@/components/tabs/plans-tab";
import { ActivityTab } from "@/components/tabs/activity-tab";
import { ConnectTab } from "@/components/tabs/connect-tab";
import { SettingsTab } from "@/components/tabs/settings-tab";

export function FlowsSection() {
  const { params } = useWorkspace();
  const key = params.get("flow") || undefined;
  return (
    <div className="flex-1 min-h-0 flex">
      <ListPane><FlowsPanel /></ListPane>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col"><FlowsTab tab={{ id: "flows", kind: "flows", key, label: "Flows" }} /></div>
    </div>
  );
}
export function PlansSection() {
  const { params } = useWorkspace();
  const key = params.get("no") || undefined;
  return (
    <div className="flex-1 min-h-0 flex">
      <ListPane><PlansPanel /></ListPane>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col"><PlansTab tab={{ id: "plans", kind: "plans", key, label: "Plans" }} /></div>
    </div>
  );
}
export function SimpleSection({ kind }: { kind: "activity" | "connect" | "settings" }) {
  return <div className="flex-1 min-h-0 flex flex-col">{kind === "activity" ? <ActivityTab /> : kind === "connect" ? <ConnectTab /> : <SettingsTab />}</div>;
}
