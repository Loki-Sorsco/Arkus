"use client";
// Connections tab: Repository (folder / git, stack, last index) · GitHub access · Databases (one row
// per environment: Test · Sync · Edit · Remove, or Connect) · Environments & safety. Database access is read-only.
import Link from "next/link";
import { useState } from "react";
import { ConnectDbModal } from "@/components/screens/db-connect";
import { GithubAccessPanelBody } from "@/components/screens/github-access";
import { dbBase, engineLabel, post, stageSummary, useDbSources, type PublicSource, type SyncResp, type TestResult } from "@/components/screens/db-shared";
import { TabToolbar, useWorkspace, type Env } from "@/components/shell/workspace";
import { Chip, Dot, Icon, Panel, Spinner, useToast } from "@/components/ui";
import { fmtNum, timeAgo } from "@/lib/ui";

const ENVS: { id: Env; label: string }[] = [{ id: "dev", label: "Dev" }, { id: "preview", label: "Preview" }, { id: "prod", label: "Prod" }];

export function ConnectTab() {
  const sources = useDbSources();
  const [modal, setModal] = useState<{ env: Env; existing: PublicSource | null } | null>(null);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Connections" meta={`${sources.sources.length} database${sources.sources.length === 1 ? "" : "s"} connected`} />
      <div className="flex-1 min-h-0 overflow-auto bg-bg">
        <div className="max-w-[1040px] px-6 py-5 flex flex-col gap-4">
          <RepositoryPanel />
          <Panel title="GitHub access" icon={Icon.git({ size: 15 })}><GithubAccessPanelBody /></Panel>
          <DatabasesPanel sources={sources} onConnect={(env, existing) => setModal({ env, existing })} />
          <SafetyPanel />
        </div>
      </div>
      <ConnectDbModal open={!!modal} onClose={() => setModal(null)} env={modal?.env ?? "dev"} existing={modal?.existing} onConnected={sources.reload} />
    </div>
  );
}

function RepositoryPanel() {
  const { project, graph } = useWorkspace();
  const code = project.snapshots.filter((s) => s.kind === "code" && s.status === "ready").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const st = (code?.stats || {}) as { files?: number; screens?: number; endpoints?: number; tables?: number; commit?: string };
  const connected = !!(project.rootPath || project.repoUrl);
  const folder = project.rootPath || project.repoUrl || "";
  return (
    <Panel title="Repository" icon={Icon.folder({ size: 15 })} right={<>
      <Link href={`/import?project=${project.slug}`} className="btn-subtle btn-sm">{connected ? "Change folder" : "Choose folder"}</Link>
      {connected && <Link href={`/import?project=${project.slug}`} className="btn-ghost btn-sm">{Icon.refresh({ size: 13 })} Re-index</Link>}
    </>}>
      {connected ? (
        <div className="kv">
          <span>{project.rootPath ? "Folder" : "Git URL"}</span><span className="font-mono text-text-2 truncate" title={folder}>{folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || folder}</span>
          <span>Stack</span><span>{project.stack?.summary || "not detected"}</span>
          <span>Last index</span><span>{code ? <span title={`version ${(st.commit || graph?.version || code.version)}`}>{timeAgo(code.createdAt)}</span> : <span className="text-amber">never</span>}</span>
          <span>Map</span><span>{code ? `${st.screens ?? 0} pages · ${st.endpoints ?? 0} APIs · ${st.tables ?? 0} tables · ${fmtNum(st.files)} files` : "run the analysis to build it"}</span>
        </div>
      ) : <div className="text-[13px] text-muted">Point Arkus at the code to build the map. <Link href={`/import?project=${project.slug}`} className="link">Choose a folder or git URL</Link></div>}
      <div className="text-[12px] text-dim mt-3">Read in place. Secrets are never read; nothing changes until a plan ships.</div>
    </Panel>
  );
}

function DatabasesPanel({ sources, onConnect }: { sources: ReturnType<typeof useDbSources>; onConnect: (env: Env, existing: PublicSource | null) => void }) {
  const { project, reloadProject, reloadGraph } = useWorkspace();
  const { toast } = useToast();
  const base = dbBase(project.slug);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([sources.reload(), reloadProject(), reloadGraph()]); };

  const test = async (s: PublicSource) => {
    setBusy(`${s.id}:test`);
    try {
      const r = await post<TestResult>(`${base}/sources/${s.id}/test`);
      if (r.ok) toast({ title: `${s.env}: connection OK`, detail: `${fmtNum(r.tableCount)} tables · ${r.stages.reduce((n, x) => n + x.ms, 0)} ms`, kind: "ok" });
      else toast({ title: `${s.env}: connection failed`, detail: r.stages?.find((x) => !x.ok)?.error || r.error || "unreachable", kind: "error" });
      await sources.reload(); await reloadProject();
    } catch (e) { toast({ title: "Test failed", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  };
  const sync = async (s: PublicSource) => {
    setBusy(`${s.id}:sync`);
    try {
      const r = await post<SyncResp>(`${base}/sources/${s.id}/sync`);
      if (!r.ok) { toast({ title: `${s.env}: sync failed`, detail: r.error, kind: "error" }); return; }
      toast({ title: r.reused ? `${s.env}: schema unchanged` : `${s.env}: schema synced`, detail: r.diff?.summary, kind: "ok" });
      await refresh();
    } catch (e) { toast({ title: "Sync failed", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  };
  const remove = async (s: PublicSource) => {
    if (!confirm(`Remove the ${s.env} database connection? The stored connection string and its schema history are deleted. Your database is not touched.`)) return;
    setBusy(`${s.id}:remove`);
    try {
      const r = await post<{ ok?: boolean; error?: string }>(`${base}/sources/${s.id}`, undefined, "DELETE");
      if (r.error) throw new Error(r.error);
      toast({ title: `${s.env} database removed`, kind: "ok" });
      await refresh();
    } catch (e) { toast({ title: "Could not remove", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  };

  return (
    <Panel title="Databases" icon={Icon.db({ size: 15 })} pad={false} right={sources.loading ? <Spinner /> : undefined}>
      <table className="tbl">
        <thead><tr><th className="w-[110px]">Environment</th><th>Database</th><th>Schema</th><th className="w-[120px]">Tested</th><th className="w-[280px]"></th></tr></thead>
        <tbody>
          {ENVS.map((e) => {
            const s = sources.byEnv(e.id);
            const b = (k: string) => busy === `${s?.id}:${k}`;
            return (
              <tr key={e.id} className="h-12">
                <td className="font-medium">{e.id === "prod" ? <span className="text-gold">Prod</span> : e.label}</td>
                {s ? (<>
                  <td>
                    <div className="flex items-center gap-2 min-w-0">
                      <Dot color={s.status === "ok" ? "green" : s.status === "error" ? "red" : "muted"} title={s.status === "ok" ? "reachable" : s.lastError || "not tested"} />
                      <Chip tone="muted">{engineLabel(s.engine)}</Chip>
                      <span className="font-mono text-[12.5px] text-text-2 truncate max-w-[260px]" title={s.display}>{s.database || s.display}</span>
                      {s.schemaOnly && <Chip tone="amber" title="Connected without row access">schema only</Chip>}
                    </div>
                    {s.lastError && <div className="text-[12px] text-red-soft truncate max-w-[420px] mt-0.5" title={s.lastError}>{s.lastError}</div>}
                  </td>
                  <td className="text-[12.5px] text-muted whitespace-nowrap" title={s.snapshot ? `introspected ${timeAgo(s.snapshot.createdAt)}` : undefined}>{stageSummary(s.snapshot?.stats)}</td>
                  <td className="text-[12.5px] text-muted whitespace-nowrap">{s.testedAt ? `tested ${timeAgo(s.testedAt)}` : "never"}</td>
                  <td>
                    <div className="flex items-center justify-end gap-0.5">
                      <button className="btn-subtle btn-xs" disabled={!!busy} onClick={() => test(s)}>{b("test") ? <Spinner /> : "Test"}</button>
                      <button className="btn-subtle btn-xs" disabled={!!busy} onClick={() => sync(s)}>{b("sync") ? <Spinner /> : "Sync schema"}</button>
                      <button className="btn-subtle btn-xs" disabled={!!busy} onClick={() => onConnect(e.id, s)}>Edit</button>
                      <button className="btn-subtle btn-xs text-red-soft" disabled={!!busy} onClick={() => remove(s)}>{b("remove") ? <Spinner /> : "Remove"}</button>
                    </div>
                  </td>
                </>) : (<>
                  <td className="text-[13px] text-dim" colSpan={3}>No database connected</td>
                  <td><div className="flex justify-end"><button className="btn-ghost btn-xs" onClick={() => onConnect(e.id, null)}>{Icon.plus({ size: 12 })} Connect</button></div></td>
                </>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function SafetyPanel() {
  return (
    <Panel title="Environments & safety" icon={Icon.lock({ size: 15 })}>
      <div className="kv">
        <span>Reads</span><span className="text-text-2">Arkus only runs SELECT and catalog queries against your databases. Every statement passes a read guard.</span>
        <span>Personal data</span><span className="text-text-2">Email, phone and similar columns are masked; password and token columns are never returned.</span>
        <span>Secrets</span><span className="text-text-2">Connection strings are encrypted with a key kept at <span className="font-mono">~/.arkus/secret.key</span> (or <span className="font-mono">ARKUS_SECRET_KEY</span>) and never shown again.</span>
        <span>Production</span><span className="text-text-2">Reads are safe on every environment. Any write to prod needs a typed confirmation, and writes only ever ship through a plan.</span>
      </div>
    </Panel>
  );
}
