"use client";
// Request half of a request tab (Params | Headers | Body | Auth), the draft model it edits, the auth
// fields shared with the environment editor, and the EnvironmentModal (base URL · headers · auth per env).
import { json } from "@codemirror/lang-json";
import CodeMirror from "@uiw/react-codemirror";
import { useCmTheme } from "@/components/screens/cm-theme";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Env } from "@/components/shell/workspace";
import { useWorkspace } from "@/components/shell/workspace";
import { Field, Modal, Spinner, Tabs, useToast } from "@/components/ui";
import type { GNode } from "@/lib/arkus/types";
import type { HttpAuth, HttpEnv, KV, RequestBody, SavedRequest } from "@/lib/arkus/http";
import { api, cx } from "@/lib/ui";
import { KVGrid } from "./kv-grid";
import { cmSetup, cmTheme } from "./response-view";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Draft = { method: string; url: string; params: KV[]; headers: KV[]; body: RequestBody; auth: "inherit" | HttpAuth; name?: string; folder?: string; endpointKey?: string };
export const emptyDraft = (): Draft => ({ method: "GET", url: "{{baseUrl}}/", params: [], headers: [], body: { mode: "none" }, auth: "inherit" });
export const draftFromSaved = (r: SavedRequest): Draft => ({ method: r.method, url: r.url, params: r.params || [], headers: r.headers || [], body: r.body || { mode: "none" }, auth: r.auth ?? "inherit", name: r.name, folder: r.folder, endpointKey: r.endpointKey });
const sample = (t?: string) => (t === "number" || t === "integer" ? 0 : t === "boolean" ? false : t === "array" ? [] : t === "object" ? {} : "");
export function draftFromEndpoint(n: GNode): Draft {
  const method = String(n.attrs?.method || "GET").toUpperCase();
  const path = String(n.attrs?.path || n.name.replace(/^[A-Z]+\s+/, ""));
  const keys = (n.attrs?.bodyKeys as { name: string; type?: string }[] | undefined) || [];
  const hasBody = keys.length > 0 && method !== "GET" && method !== "HEAD";
  return { ...emptyDraft(), method, url: `{{baseUrl}}${path.startsWith("/") ? path : `/${path}`}`, endpointKey: n.key, body: hasBody ? { mode: "json", text: JSON.stringify(Object.fromEntries(keys.map((k) => [k.name, sample(k.type)])), null, 2) } : { mode: "none" } };
}
/** Stable string for dirty checks (ignores row order noise only in so far as the editor keeps order). */
export const draftSig = (d: Draft) => JSON.stringify({ m: d.method, u: d.url, p: d.params, h: d.headers, b: d.body, a: d.auth, n: d.name, f: d.folder });

const SECRET_NAMES = /^(authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
type EditorTab = "params" | "headers" | "body" | "auth";

export function RequestEditor({ draft, onChange }: { draft: Draft; onChange: (patch: Partial<Draft>) => void }) {
  const syntaxTheme = useCmTheme();
  const [tab, setTab] = useState<EditorTab>(draft.body.mode !== "none" ? "body" : "params");
  const extensions = useMemo(() => [cmTheme, json()], []);
  const on = (rows: KV[]) => rows.filter((r) => r.enabled && r.name).length;
  const beautify = () => { try { onChange({ body: { ...draft.body, text: JSON.stringify(JSON.parse(draft.body.text || ""), null, 2) } }); } catch { /* leave invalid JSON alone */ } };
  const items = [{ id: "params" as const, label: "Params", count: on(draft.params) || undefined }, { id: "headers" as const, label: "Headers", count: on(draft.headers) || undefined }, { id: "body" as const, label: "Body" }, { id: "auth" as const, label: "Auth" }];
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-8 flex-none flex items-center gap-2 px-3 border-b border-border">
        <Tabs size="sm" value={tab} onChange={setTab} items={items} />
        {tab === "body" && <Tabs size="sm" value={draft.body.mode} onChange={(mode) => onChange({ body: { ...draft.body, mode } })} items={[{ id: "none", label: "none" }, { id: "json", label: "JSON" }, { id: "text", label: "Text" }, { id: "form", label: "Form" }]} />}
        <span className="flex-1" />
        {tab === "body" && draft.body.mode === "json" && <button className="btn-subtle btn-xs" onClick={beautify} title="Re-indent the JSON body">Beautify</button>}
        {tab === "auth" && <span className="text-[11.5px] text-dim">Secrets are stored encrypted and never shown in full.</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-bg-deep">
        {tab === "params" && <KVGrid rows={draft.params} onChange={(params) => onChange({ params })} namePlaceholder="param" />}
        {tab === "headers" && <KVGrid rows={draft.headers} onChange={(headers) => onChange({ headers })} namePlaceholder="header" secretNames={SECRET_NAMES} />}
        {tab === "body" && draft.body.mode === "none" && <div className="px-3 py-3 text-[12.5px] text-dim">This request has no body.</div>}
        {tab === "body" && draft.body.mode === "json" && <CodeMirror value={draft.body.text || ""} height="100%" style={{ height: "100%" }} theme={syntaxTheme} extensions={extensions} onChange={(text) => onChange({ body: { ...draft.body, text } })} basicSetup={cmSetup} placeholder={"{\n  \n}"} />}
        {tab === "body" && draft.body.mode === "text" && <textarea className="w-full h-full min-h-[120px] resize-none bg-transparent px-3 py-2 font-mono text-[12px] text-text outline-none leading-relaxed" value={draft.body.text || ""} onChange={(e) => onChange({ body: { ...draft.body, text: e.target.value } })} spellCheck={false} placeholder="Raw text body" />}
        {tab === "body" && draft.body.mode === "form" && <KVGrid rows={draft.body.form || []} onChange={(form) => onChange({ body: { ...draft.body, form } })} namePlaceholder="field" />}
        {tab === "auth" && (
          <div className="p-3 flex flex-col gap-3 max-w-[520px]">
            <div className="flex items-center gap-1 text-[12.5px]">
              {[{ id: "inherit", label: "Inherit from environment" }, { id: "override", label: "Override" }].map((o) => {
                const active = (draft.auth === "inherit") === (o.id === "inherit");
                return <button key={o.id} className={cx("btn-xs rounded-[6px] border px-2 h-6 cursor-pointer transition", active ? "bg-surface-3 border-border-strong text-text" : "bg-transparent border-border text-muted hover:text-text")} onClick={() => onChange({ auth: o.id === "inherit" ? "inherit" : { type: "bearer" } })}>{o.label}</button>;
              })}
            </div>
            {draft.auth === "inherit" ? <div className="text-[12px] text-dim leading-relaxed">The environment's auth (set in the Environments section of the API client panel) is added to this request when it is sent.</div>
              : <AuthFields value={draft.auth} onChange={(auth) => onChange({ auth })} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Auth type select + the fields it needs. Used by the request Auth tab and the environment editor. */
export function AuthFields({ value, onChange }: { value: HttpAuth; onChange: (a: HttpAuth) => void }) {
  const set = (patch: Partial<HttpAuth>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-2.5">
      <Field label="Type"><select className="select input-sm font-mono text-[12.5px] w-[200px]" value={value.type} onChange={(e) => onChange({ type: e.target.value as HttpAuth["type"] })}><option value="none">none</option><option value="bearer">bearer token</option><option value="basic">basic</option><option value="apikey">api key header</option></select></Field>
      {value.type === "bearer" && <Field label="Token" hint="Sent as Authorization: Bearer …"><input className="input input-sm font-mono text-[12.5px]" type="password" autoComplete="off" value={value.token || ""} onChange={(e) => set({ token: e.target.value })} /></Field>}
      {value.type === "basic" && <div className="grid grid-cols-2 gap-2">
        <Field label="Username"><input className="input input-sm font-mono text-[12.5px]" autoComplete="off" value={value.username || ""} onChange={(e) => set({ username: e.target.value })} /></Field>
        <Field label="Password"><input className="input input-sm font-mono text-[12.5px]" type="password" autoComplete="off" value={value.password || ""} onChange={(e) => set({ password: e.target.value })} /></Field>
      </div>}
      {value.type === "apikey" && <div className="grid grid-cols-2 gap-2">
        <Field label="Header name"><input className="input input-sm font-mono text-[12.5px]" value={value.headerName || ""} placeholder="X-API-Key" onChange={(e) => set({ headerName: e.target.value })} /></Field>
        <Field label="Key"><input className="input input-sm font-mono text-[12.5px]" type="password" autoComplete="off" value={value.token || ""} onChange={(e) => set({ token: e.target.value })} /></Field>
      </div>}
    </div>
  );
}

export type EnvView = Omit<HttpEnv, "auth"> & { auth: HttpAuth & { hasToken?: boolean } };
export const ENV_LABEL: Record<Env, string> = { dev: "Dev", preview: "Preview", prod: "Prod" };

/** Edit one environment (base URL · headers · auth). Secrets come back masked; leaving the mask keeps them. */
export function EnvironmentModal({ env, onClose, onSaved }: { env: Env | null; onClose: () => void; onSaved?: (env: Env, value: EnvView) => void }) {
  const { project } = useWorkspace();
  const { toast } = useToast();
  const [value, setValue] = useState<EnvView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!env) { setValue(null); return; }
    let live = true;
    api<{ value: EnvView }>(`/api/projects/${project.slug}/http/env?env=${env}`).then((r) => { if (live) setValue(r.value); }).catch((e) => toast({ title: "Could not load environment", detail: (e as Error).message, kind: "error" }));
    return () => { live = false; };
  }, [env, project.slug, toast]);
  const save = useCallback(async () => {
    if (!env || !value) return;
    setBusy(true);
    try { const r = await api<{ value: EnvView }>(`/api/projects/${project.slug}/http/env`, { method: "PUT", json: { env, value } }); toast({ title: `${ENV_LABEL[env]} environment saved`, kind: "ok" }); onSaved?.(env, r.value); onClose(); }
    catch (e) { toast({ title: "Save failed", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(false); }
  }, [env, value, project.slug, toast, onSaved, onClose]);
  return (
    <Modal open={!!env} onClose={onClose} title={env ? `${ENV_LABEL[env]} environment` : ""} subtitle="Base URL, headers and auth added to every request sent in this environment" width={600}
      footer={<><button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button><button className="btn-primary btn-sm" disabled={busy || !value} onClick={() => void save()}>{busy ? <Spinner /> : "Save"}</button></>}>
      {!value ? <div className="py-6 flex justify-center"><Spinner /></div> : (
        <div className="flex flex-col gap-4">
          <Field label="Base URL" hint="Used for {{baseUrl}} and for relative URLs"><input className="input input-sm font-mono text-[12.5px]" value={value.baseUrl} placeholder={env === "dev" ? "http://localhost:3000" : "https://"} spellCheck={false} onChange={(e) => setValue({ ...value, baseUrl: e.target.value })} /></Field>
          <div><span className="label">Headers</span><div className="border border-border rounded-[6px] overflow-hidden bg-bg-deep"><KVGrid rows={value.headers} onChange={(headers) => setValue({ ...value, headers })} namePlaceholder="header" secretNames={SECRET_NAMES} /></div></div>
          <div><span className="label">Auth</span><AuthFields value={value.auth} onChange={(auth) => setValue({ ...value, auth })} /></div>
        </div>
      )}
    </Modal>
  );
}
