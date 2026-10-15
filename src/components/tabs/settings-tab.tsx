"use client";
// Settings tab: project name and facts, AI (included with Arkus or your own key), exports, danger zone; MCP (coming) and members.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { Chip, CopyButton, Dot, Field, Panel, Spinner, useToast } from "@/components/ui";
import { api, cx, useApi } from "@/lib/ui";

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

type ProviderRow = { id: string; label: string; model: string; fastModel: string; keyHint: string; getKeyUrl: string | null; needsBaseUrl: boolean; keyOptional: boolean; baseUrl: string };
type AiInfo = {
  configured: boolean; mode: "included" | "byok" | "off"; provider: string | null; model: string | null; includedAvailable: boolean; source: "included" | "byok" | null;
  byok: { provider: string | null; model: string | null; baseUrl: string | null; keyMasked: string | null } | null;
  includedModel: string | null; includedProvider: string | null; providers: ProviderRow[];
};
type Mode = AiInfo["mode"];

/** Three ways to run AI: included with Arkus (server key), the user's own key (verified, stored encrypted), or off. */
function AiPanel({ onChange }: { onChange: () => Promise<unknown> | void }) {
  const info = useApi<AiInfo>("/api/settings/ai");
  const { toast } = useToast();
  const [choice, setChoice] = useState<Mode | null>(null);
  const [provider, setProvider] = useState("groq");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; ms: number; model: string | null; error?: string } | null>(null);
  const d = info.data;
  const mode: Mode = choice ?? d?.mode ?? "included";
  const prov = d?.providers.find((p) => p.id === provider) ?? null;
  // Prefill the form from the saved key the first time the data arrives.
  useEffect(() => {
    if (!d) return;
    if (d.byok?.provider) { setProvider(d.byok.provider); setModel(d.byok.model || ""); setBaseUrl(d.byok.baseUrl || ""); }
  }, [d]);
  const pickProvider = (id: string) => { const p = d?.providers.find((x) => x.id === id); setProvider(id); setModel(p?.model || ""); setBaseUrl(""); setKey(""); setErr(null); };
  const post = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true); setErr(null); setTest(null);
    try { await api("/api/settings/ai", { json: body }); await info.reload(true); await onChange(); if (done) toast({ title: done, kind: "ok" }); return true; }
    catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); }
  };
  const choose = async (m: Mode) => {
    if (busy || (m === "included" && !d?.includedAvailable)) return;
    setChoice(m); setErr(null);
    if (m === "included") await post({ mode: "included" }, "AI is on, included with Arkus");
    if (m === "off") await post({ mode: "off" }, "AI is off");
  };
  const save = async () => {
    const ok = await post({ mode: "byok", provider, key, model, baseUrl: prov?.needsBaseUrl ? baseUrl : undefined }, "Key saved, AI is on");
    if (ok) { setKey(""); setChoice(null); }
  };
  const runTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await api("/api/settings/ai", { json: { test: true } })); } catch (e) { setTest({ ok: false, ms: 0, model: null, error: (e as Error).message }); } finally { setBusy(false); }
  };
  const label = (id: string | null) => d?.providers.find((p) => p.id === id)?.label || id || "";
  const statusLine = !d ? "Loading…" : !d.configured
    ? d.mode === "off" ? "AI is off" : "AI is off · nothing configured yet"
    : `AI is on · ${d.source === "included" ? "Included" : `your ${label(d.provider)} key`} · ${d.model}`;
  const card = (m: Mode, title: string, body: string, disabled?: boolean, note?: string) => (
    <button type="button" disabled={disabled || busy} onClick={() => choose(m)} className={cx("text-left rounded-[7px] border px-3 py-2.5 transition flex gap-2.5 items-start disabled:opacity-60 disabled:cursor-not-allowed", mode === m ? "border-accent bg-accent/5" : "border-border hover:border-border-strong bg-surface-2/40")}>
      <span className={cx("mt-[3px] w-3.5 h-3.5 rounded-full border flex-none flex items-center justify-center", mode === m ? "border-accent" : "border-border-strong")}>{mode === m && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}</span>
      <span className="min-w-0"><span className="block text-[13px] text-text">{title}</span><span className="block text-[12px] text-muted leading-relaxed">{body}</span>{note && <span className="block text-[12px] text-amber mt-0.5">{note}</span>}</span>
    </button>
  );
  return (
    <Panel title="AI" right={d?.configured ? <Chip tone="green">on</Chip> : <Chip tone="muted">off</Chip>}>
      <div className="flex flex-col gap-3 text-[13px] text-muted leading-relaxed">
        <p>Everything in Arkus works without AI: import, map, pages, APIs, database, SQL you write, plans. AI adds the extras: Ask in plain English, English to SQL, flow names, writeups and AI blueprints. Source text is secret-scrubbed before anything is sent.</p>
        <div className="flex items-center gap-2 text-text-2 min-h-[28px]">
          <Dot color={d?.configured ? "green" : "muted"} /><span className="truncate">{statusLine}</span>
          {d?.configured && <button className="btn-subtle btn-xs ml-auto flex-none" disabled={busy} onClick={runTest}>{busy && test === null ? <Spinner /> : "Test"}</button>}
        </div>
        {test && <div className={cx("text-[12.5px] -mt-1", test.ok ? "text-green" : "text-red-soft")}>{test.ok ? `Answered in ${test.ms} ms (${test.model})` : `Failed${test.ms ? ` after ${test.ms} ms` : ""}: ${test.error}`}</div>}
        <div className="grid gap-2">
          {card("included", "Included with Arkus", "Uses Arkus's AI. Nothing to set up.", !d?.includedAvailable, !d ? undefined : d.includedAvailable ? undefined : "Not available on this Arkus: the server has no included key. Use your own key below.")}
          {card("byok", "Use my own key", "Groq, OpenAI, Anthropic, Google Gemini or any OpenAI-compatible endpoint (OpenRouter, Ollama). Checked with the provider, then stored encrypted.")}
          {card("off", "Off", "Everything still works; you just write SQL and read the structure yourself.")}
        </div>
        {mode === "byok" && d && (
          <div className="flex flex-col gap-3 border border-border rounded-[7px] p-3 bg-surface-2/30">
            <Field label="Provider"><select className="select" value={provider} onChange={(e) => pickProvider(e.target.value)}>{d.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
            {prov?.needsBaseUrl && <Field label="Base URL" hint="The OpenAI-compatible root, ending in /v1."><input className="input font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1 or http://localhost:11434/v1" spellCheck={false} /></Field>}
            <Field label="Model" hint={prov?.model ? `Default: ${prov.model}. Change it if you prefer another model from this provider.` : "The exact model name your endpoint serves."}><input className="input font-mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={prov?.model || "llama3.1"} spellCheck={false} /></Field>
            <Field label={d.byok?.keyMasked && d.byok.provider === provider ? `API key (saved: ${d.byok.keyMasked})` : "API key"} right={prov?.getKeyUrl ? <a href={prov.getKeyUrl} target="_blank" rel="noreferrer" className="link">Get a key</a> : undefined} hint={err ? <span className="text-red-soft">{err}</span> : d.byok?.keyMasked && d.byok.provider === provider ? "Leave empty to keep the saved key and just change the model. Never shown or sent to the browser." : `Looks like ${prov?.keyHint || "…"}. Checked with ${prov?.label || "the provider"}, then stored encrypted on this machine. No restart needed.`}>
              <div className="flex gap-2">
                <input className="input font-mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={prov?.keyHint || ""} autoComplete="off" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && save()} />
                <button className="btn-primary flex-none" disabled={busy || (!key.trim() && !prov?.keyOptional && !(d.byok?.keyMasked && d.byok.provider === provider))} onClick={save}>{busy ? <Spinner /> : "Save"}</button>
              </div>
            </Field>
          </div>
        )}
        {err && mode !== "byok" && <div className="text-[12.5px] text-red-soft">{err}</div>}
      </div>
    </Panel>
  );
}
