"use client";
// Live preview of a page: the user's running app in an iframe at the environment's base URL (the
// same one Test and Live API use). Browsers render it directly, so this also works for localhost
// apps in hosted mode. Some apps refuse to be embedded (X-Frame-Options); we say so and offer a tab.
import { useEffect, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Icon, Spinner } from "@/components/ui";
import { api, cx } from "@/lib/ui";

type EnvView = { baseUrl?: string };
export function PagePreview({ path }: { path: string }) {
  const { project, env } = useWorkspace();
  const [base, setBase] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [wide, setWide] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => { let on = true; api<{ value: EnvView & Record<string, unknown> }>(`/api/projects/${project.slug}/http/env?env=${env}`).then((r) => { if (on) { setBase(r.value.baseUrl || ""); setDraft(r.value.baseUrl || ""); } }).catch(() => { if (on) setBase(""); }); return () => { on = false; }; }, [project.slug, env]);
  const save = async () => {
    const next = draft.trim().replace(/\/+$/, "");
    if (!next) return;
    setSaving(true);
    try { const cur = await api<{ value: Record<string, unknown> }>(`/api/projects/${project.slug}/http/env?env=${env}`); await api(`/api/projects/${project.slug}/http/env`, { method: "PUT", json: { env, value: { ...cur.value, baseUrl: next } } }); setBase(next); }
    finally { setSaving(false); }
  };
  const routePath = path.replace(/:([A-Za-z_]+)/g, "1").replace(/\[([^\]]+)\]/g, "1");
  const url = base ? `${base}${routePath.startsWith("/") ? "" : "/"}${routePath}` : "";
  if (base === null) return <div className="text-[12px] text-dim"><Spinner /></div>;
  if (!base) return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] text-muted prose">Tell Arkus where the app runs on <span className="capitalize">{env}</span> and this page shows here live.</div>
      <div className="flex gap-1.5"><input className="input input-sm font-mono flex-1" placeholder="http://localhost:3000" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /><button className="btn-primary btn-sm" disabled={saving || !draft.trim()} onClick={() => void save()}>{saving ? <Spinner /> : "Show"}</button></div>
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-dim min-w-0">
        <span className="font-mono truncate flex-1" title={url}>{url.replace(/^https?:\/\//, "")}</span>
        <button className="btn-icon btn-xs" title={wide ? "Phone width" : "Full width"} onClick={() => setWide((w) => !w)}>{Icon.layers({ size: 12 })}</button>
        <button className="btn-icon btn-xs" title="Reload" onClick={() => setNonce((n) => n + 1)}>{Icon.refresh({ size: 12 })}</button>
        <a className="btn-icon btn-xs" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">{Icon.external({ size: 12 })}</a>
      </div>
      <div className={cx("rounded-[7px] border border-border bg-bg-deep overflow-hidden mx-auto", wide ? "w-full" : "w-[320px]")} style={{ height: 420 }}>
        <iframe key={nonce} src={url} title={`Preview of ${path}`} className="w-full h-full bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" />
      </div>
      <div className="text-[10.5px] text-dim prose">Live from your running app. If it stays blank, the app refuses to be embedded; use the new-tab button.</div>
    </div>
  );
}
