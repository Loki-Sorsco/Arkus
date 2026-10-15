"use client";
// Small pieces every database tab shares: the sync action (POST sources/:id/sync + toast), the
// "connect a database" and "schema-only" empty states (with the connect dialog), the drift fetch,
// and the tab descriptor for a table.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { EmptyState, Icon, Spinner, useToast } from "@/components/ui";
import { cx, useApi } from "@/lib/ui";
import { ConnectDbModal } from "@/components/screens/db-connect";
import { dbBase, post, stageSummary, type DriftResult, type PublicSource, type SyncResp } from "@/components/screens/db-shared";

// Every mounted schema view (table list, section, open table) owns its own useDbSchema() fetch; after a DDL
// change the modals call notifySchemaChanged() so all of them reload before the UI navigates.
const schemaListeners = new Set<() => void | Promise<void>>();
export function useSchemaChanges(reload: () => void | Promise<void>) {
  useEffect(() => { schemaListeners.add(reload); return () => { schemaListeners.delete(reload); }; }, [reload]);
}
export async function notifySchemaChanged() {
  await Promise.all([...schemaListeners].map((l) => Promise.resolve().then(l).catch(() => undefined)));
}

export const tableTab = (name: string): Omit<Tab, "id"> => ({ kind: "table", key: `table:${name}`, label: name });
export const tableName = (key: string | null | undefined) => (key?.startsWith("table:") ? key.slice(6) : null);

/** Re-introspect the env's source. Toasts the diff summary, then reloads whatever the caller passes. */
export function useDbSync(source: PublicSource | null, reload: () => Promise<void> | void) {
  const { project, reloadProject } = useWorkspace();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const sync = useCallback(async () => {
    if (!source || syncing) return;
    setSyncing(true);
    try {
      const r = await post<SyncResp>(`${dbBase(project.slug)}/sources/${source.id}/sync`);
      if (!r.ok) throw new Error(r.error || `sync failed (${r.status})`);
      toast({ title: r.reused ? "Schema unchanged" : "Schema synced", detail: r.diff?.counts.total ? r.diff.summary : stageSummary(r.snapshot?.stats), kind: "ok" });
      await Promise.all([reload(), reloadProject()]);
    } catch (e) { toast({ title: "Sync failed", detail: (e as Error).message, kind: "error" }); }
    finally { setSyncing(false); }
  }, [source, syncing, project.slug, reload, reloadProject, toast]);
  return { syncing, sync };
}

/** Subtle "Sync" button; icon-only when `icon` is set. Hidden when there is no source. */
export function SyncButton({ source, reload, icon, label = "Sync schema", className }: { source: PublicSource | null; reload: () => Promise<void> | void; icon?: boolean; label?: string; className?: string }) {
  const { syncing, sync } = useDbSync(source, reload);
  if (!source) return null;
  if (icon) return <button className={cx("btn-icon btn-xs", className)} disabled={syncing} onClick={sync} title={label} aria-label={label}>{syncing ? <Spinner /> : Icon.refresh({ size: 13 })}</button>;
  return <button className={cx("btn-subtle btn-xs", className)} disabled={syncing} onClick={sync}>{syncing ? <Spinner /> : Icon.refresh({ size: 12 })} {label}</button>;
}

/** "Connect database" button that owns its ConnectDbModal for the current env. */
export function ConnectButton({ existing, onConnected, className = "btn-primary btn-sm", children = "Connect database" }: { existing?: PublicSource | null; onConnected?: () => Promise<void> | void; className?: string; children?: ReactNode }) {
  const { env } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>{children}</button>
      <ConnectDbModal open={open} onClose={() => setOpen(false)} env={env} existing={existing} onConnected={async () => { setOpen(false); await onConnected?.(); }} />
    </>
  );
}

/** Empty state for "no database connected on this env" with the connect dialog. */
export function ConnectEmpty({ title, hint, onConnected }: { title: string; hint?: ReactNode; onConnected?: () => Promise<void> | void }) {
  const { env } = useWorkspace();
  return <EmptyState icon={Icon.db()} title={title} hint={hint ?? `Connect the ${env} database to browse rows, run queries and keep the schema in sync. Read-only; credentials are stored encrypted.`} action={<ConnectButton onConnected={onConnected} />} />;
}

/** Empty state for schema-only connections (introspection allowed, reads are not). */
export function LockedEmpty({ title = "Schema only", hint }: { title?: string; hint?: ReactNode }) {
  return <EmptyState icon={Icon.lock()} title={title} hint={hint ?? "This connection was added as schema-only: Arkus introspects tables and columns but never reads rows. Reconnect without the schema-only option to browse data."} />;
}

export function CenteredSpinner() {
  return <div className="flex-1 min-h-0 flex items-center justify-center"><Spinner /></div>;
}

/** Live schema vs code-declared tables for the current env. */
export function useDrift() {
  const { project, env } = useWorkspace();
  const r = useApi<DriftResult>(`${dbBase(project.slug)}/drift?env=${env}`);
  return { drift: r.data, loading: r.loading, error: r.error, reload: () => r.reload(true), count: r.data?.diff?.counts.total ?? 0 };
}
