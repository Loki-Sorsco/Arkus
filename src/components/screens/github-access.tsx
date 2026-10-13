"use client";
// GitHub access for private repositories. One token per machine: verified against GitHub, stored
// encrypted in Arkus's own database, never shown again. Used on /import (Private repository) and
// on Connections. `draft` mode lets the import form collect a token to send with the request instead.
import { useState } from "react";
import { api, useApi } from "@/lib/ui";
import { Dot, Field, Icon, Spinner, Toggle } from "@/components/ui";

export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
export type GithubInfo = { configured: boolean; login?: string };
export function useGithubAccess() { return useApi<GithubInfo>("/api/settings/github"); }

/** Status line when a token is saved: "GitHub token saved for <login> · Forget". */
export function GithubSaved({ info, onForget, note }: { info: GithubInfo; onForget: () => Promise<void> | void; note?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-text-2 min-h-[28px]">
      <Dot color="green" />GitHub token saved{info.login ? <> for <span className="font-medium text-text">{info.login}</span></> : null}
      <span className="text-dim">· {note || "private repositories will clone"}</span>
      <button className="btn-subtle btn-xs ml-auto" disabled={busy} onClick={async () => { setBusy(true); try { await onForget(); } finally { setBusy(false); } }}>Forget token</button>
    </div>
  );
}

export function CreateTokenLink() {
  return <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">Create a token on GitHub {Icon.external({ size: 11 })}</a>;
}

/**
 * Token input. `onDraft` (import form): report the typed token + remember flag upward instead of saving here.
 * Without `onDraft`: Save verifies with GitHub and stores it.
 */
export function GithubTokenField({ onDraft, onSaved }: { onDraft?: (d: { token: string; remember: boolean }) => void; onSaved?: () => void }) {
  const [token, setTokenState] = useState("");
  const [remember, setRememberState] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setToken = (t: string) => { setTokenState(t); onDraft?.({ token: t, remember }); };
  const setRemember = (b: boolean) => { setRememberState(b); onDraft?.({ token, remember: b }); };
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api("/api/settings/github", { json: { token } }); setToken(""); onSaved?.(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="GitHub token" right={<CreateTokenLink />} hint={err ? <span className="text-red-soft">{err}</span> : <>Fine-grained token with <span className="text-text-2">Contents: read</span> on the repository. Verified with GitHub, stored encrypted on this machine, never shown again.</>}>
        <div className="flex gap-2">
          <input className="input font-mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… or ghp_…" autoComplete="off" spellCheck={false} />
          {!onDraft && <button className="btn-ghost flex-none" disabled={!token.trim() || busy} onClick={save}>{busy ? <Spinner /> : "Save token"}</button>}
        </div>
      </Field>
      {onDraft && <Toggle checked={remember} onChange={setRemember} label="Remember this token on this machine" hint={remember ? "Reused for later clones and re-indexing." : "Used for this import only, then discarded."} />}
    </div>
  );
}

/** Self-contained block for Connections / Settings: status + input. */
export function GithubAccessPanelBody() {
  const info = useGithubAccess();
  const forget = async () => { await api("/api/settings/github", { method: "DELETE" }); await info.reload(true); };
  if (info.loading && !info.data) return <Spinner />;
  if (info.data?.configured) return <GithubSaved info={info.data} onForget={forget} note="used when cloning private repositories" />;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] text-muted">No token saved. Public repositories clone without one; add a token to import private repositories.</div>
      <GithubTokenField onSaved={() => info.reload(true)} />
    </div>
  );
}
