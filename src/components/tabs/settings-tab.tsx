"use client";
// Settings tab: project name and facts, AI status (Groq key), exports, danger zone; MCP (coming) and members.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { Chip, CopyButton, Dot, Field, Panel, Spinner, useToast } from "@/components/ui";
import { api, useApi } from "@/lib/ui";

export function SettingsTab() {
  const { project, reloadProject } = useWorkspace();
  const { toast } = useToast();
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const mcp = `npx -y @arkus/mcp --project ${project.slug}`;
  const save = async () => { setSaving(true); try { await api(`/api/projects/${project.slug}`, { method: "PATCH", json: { name } }); await reloadProject(); toast({ title: "Renamed", kind: "ok" }); } catch (e) { toast({ title: "Couldn't rename", detail: (e as Error).message, kind: "error" }); } finally { setSaving(false); } };
  const remove = async () => { if (!confirm(`Remove ${project.name} from Arkus? Its metadata is deleted; your code and database are not touched.`)) return; await api(`/api/projects/${project.slug}`, { method: "DELETE" }); router.push("/"); };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Settings" meta={project.name} />
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="px-6 py-5 grid grid-cols-[minmax(0,640px)_320px] gap-4 items-start max-w-[1040px]">
          <div className="flex flex-col gap-4 min-w-0">
            <Panel title="Project">
              <div className="flex flex-col gap-4">
                <Field label="Name"><div className="flex gap-2"><input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && name.trim() !== project.name && save()} /><button className="btn-ghost" disabled={saving || name.trim() === project.name || !name.trim()} onClick={save}>Save</button></div></Field>
                <div className="kv"><span>slug</span><span className="font-mono text-text-2">{project.slug}</span><span>mode</span><span className="text-text-2">{project.mode}</span><span>folder</span><span className="font-mono text-[12.5px] text-text-2 break-all">{project.rootPath || "—"}</span><span>stack</span><span className="text-text-2">{project.stack?.summary || "—"}</span></div>
              </div>
            </Panel>
            <AiPanel onChange={reloadProject} />
            <Panel title="Export">
              <div className="flex items-center gap-3"><a className="btn-ghost btn-sm" href={`/api/projects/${project.slug}/export`}>Export spec JSON</a><span className="text-[12.5px] text-muted">Every entity, field, endpoint and binding in one file. Point your AI at it.</span></div>
            </Panel>
            <Panel title="Danger zone" className="border-red/30">
              <div className="flex items-center gap-4"><div className="flex-1 text-[13px] text-muted leading-relaxed">Your code keeps working without Arkus. Removing the project deletes only Arkus&apos;s metadata; your repo and database are untouched.</div><button className="btn-danger btn-sm" onClick={remove}>Remove project</button></div>
            </Panel>
          </div>
          <div className="flex flex-col gap-4 min-w-0">
            <Panel title="MCP server" right={<Chip tone="muted">coming</Chip>}>
              <div className="flex flex-col gap-3 text-[12.5px] text-muted leading-relaxed">
                <p>Let Claude Code or Cursor read this project&apos;s spec. Read access only; changes still go through plans.</p>
                <div className="border border-border rounded-[6px] overflow-hidden"><div className="flex items-center justify-between px-2.5 h-8 border-b border-border"><span className="eyebrow">command</span><CopyButton text={mcp} /></div><pre className="p-2.5 text-[12px] text-text-2 bg-bg-deep/40 overflow-auto">{mcp}</pre></div>
                <p>Until the package ships, use Export spec JSON instead.</p>
              </div>
            </Panel>
            <Panel title="Members & roles">
              <div className="text-[12.5px] text-muted leading-relaxed">Local mode: you are the <span className="text-text">Owner</span>. Roles (Editor, Reviewer, Viewer), per-environment permissions and layer scopes arrive with the hosted control plane. Until then the typed-confirmation prod gate stands in for &ldquo;a Reviewer must approve every plan that ships to production&rdquo;.</div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Groq key: verified with Groq, stored encrypted in Arkus's own DB, live immediately. Falls back to GROQ_API_KEY in .env. */
function AiPanel({ onChange }: { onChange: () => Promise<unknown> | void }) {
  const info = useApi<{ configured: boolean; source: "settings" | "env" | null }>("/api/settings/ai");
  const { toast } = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = !!info.data?.configured;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api("/api/settings/ai", { json: { key } }); setKey(""); await info.reload(true); await onChange(); toast({ title: "Key saved", detail: "Ask, English to SQL, writeups and blueprints now use your Groq key.", kind: "ok" }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const forget = async () => { setBusy(true); try { await api("/api/settings/ai", { method: "DELETE" }); await info.reload(true); await onChange(); } finally { setBusy(false); } };
  return (
    <Panel title="AI" right={on ? <Chip tone="green">on</Chip> : <Chip tone="muted">off</Chip>}>
      <div className="flex flex-col gap-3 text-[13px] text-muted leading-relaxed">
        <p>Everything in Arkus works without AI: import, map, pages, APIs, database, SQL you write, plans. A Groq key (free tier) switches on the extras: Ask in plain English, English to SQL, flow names, writeups and AI blueprints. Source text is secret-scrubbed before anything is sent.</p>
        {on && (
          <div className="flex items-center gap-2 text-text-2 min-h-[28px]"><Dot color="green" />AI is on · {info.data?.source === "env" ? <>using the key from <span className="font-mono">.env</span> on this machine</> : "using your saved key"}<span className="text-dim">· never shown or sent to the browser</span>{info.data?.source === "settings" && <button className="btn-subtle btn-xs ml-auto" disabled={busy} onClick={forget}>Forget key</button>}</div>
        )}
        <Field label={on ? "Use a different Groq key" : "Groq API key"} right={<a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="link">Get a free key</a>} hint={err ? <span className="text-red-soft">{err}</span> : on ? "Your key replaces the current one for every AI feature. Checked with Groq, stored encrypted on this machine." : "Checked with Groq, then stored encrypted on this machine. No restart needed."}>
          <div className="flex gap-2">
            <input className="input font-mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="gsk_…" autoComplete="off" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && key.trim() && save()} />
            <button className={on ? "btn-ghost flex-none" : "btn-primary flex-none"} disabled={!key.trim() || busy} onClick={save}>{busy ? <Spinner /> : on ? "Use this key" : "Turn on AI"}</button>
          </div>
        </Field>
      </div>
    </Panel>
  );
}
