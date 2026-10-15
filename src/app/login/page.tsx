"use client";
// Sign in (hosted Arkus only). Google is the only provider in V1.
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ArkusMark } from "@/components/shell/standalone";
import { useMe } from "@/lib/me";
import { cx } from "@/lib/ui";

export default function LoginPage() { return <Suspense><Login /></Suspense>; }

function Login() {
  const sp = useSearchParams();
  const me = useMe();
  const next = sp.get("next") || "/";
  const error = sp.get("error");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"developer" | "viewer">("developer");
  const [busy, setBusy] = useState(false);
  const [devErr, setDevErr] = useState<string | null>(null);
  const devLogin = async () => {
    setBusy(true); setDevErr(null);
    try { const r = await fetch("/api/auth/dev", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Sign-in failed"); window.location.replace(next); }
    catch (e) { setDevErr((e as Error).message); setBusy(false); }
  };
  if (me && !me.cloud) { if (typeof window !== "undefined") window.location.replace("/"); return null; }
  if (me?.user) { if (typeof window !== "undefined") window.location.replace(next); return null; }
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-bg dots px-6">
      <div className="w-full max-w-[400px] flex flex-col items-center text-center gap-5">
        <div className="flex items-center gap-2"><ArkusMark size={28} /><span className="font-mono text-[18px] font-semibold">arkus</span></div>
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight leading-tight prose">See your whole app.<br /><span className="text-muted">Change it safely.</span></h1>
          <p className="text-[13px] text-muted mt-3 leading-relaxed prose">Sign in to keep your projects, maps and plans in one place.</p>
        </div>
        {error && <div className="w-full rounded-[7px] border border-red/40 bg-red/10 text-red-soft text-[12.5px] px-3 py-2 prose">{error === "state" ? "That sign-in link expired. Try again." : "Google sign-in failed. Try again, or contact the person who runs this Arkus."}</div>}
        <div className="w-full grid grid-cols-2 gap-2 text-left">
          {([["developer", "Developer", "See everything and make changes: edit code, rows and APIs."], ["viewer", "Viewer", "Look around safely. Nothing can be changed in this mode."]] as const).map(([id, label, hint]) => (
            <button key={id} type="button" onClick={() => setRole(id)} className={cx("rounded-[7px] border px-3 py-2.5 transition cursor-pointer", role === id ? "border-accent bg-accent/10" : "border-border bg-surface hover:border-border-strong")}>
              <div className="text-[13px] font-semibold flex items-center gap-2"><span className={cx("w-3 h-3 rounded-full border", role === id ? "border-accent bg-accent" : "border-border-strong")} />{label}</div>
              <div className="text-[11.5px] text-muted mt-1 leading-snug prose">{hint}</div>
            </button>
          ))}
        </div>
        {me?.devLogin && (
          <form className="w-full flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void devLogin(); }}>
            <input className="input font-mono text-center" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <button className="btn-ghost w-full h-10 text-[13px]" disabled={busy || !email.trim()} type="submit">{busy ? "Signing in…" : "Continue with email (development)"}</button>
            {devErr && <div className="text-[12px] text-red-soft">{devErr}</div>}
            <div className="text-[11px] text-dim prose">Development sign-in is on because ARKUS_DEV_LOGIN=true. Turn it off in production.</div>
          </form>
        )}
        {me?.google === false && !me?.devLogin ? (
          <div className="w-full rounded-[7px] border border-amber/40 bg-amber/10 text-amber text-[12.5px] px-3 py-2 prose">Google sign-in is not configured on this server yet.</div>
        ) : me?.google === false ? null : (
          <a href={`/api/auth/google?next=${encodeURIComponent(next)}&role=${role}`} className="btn-primary w-full h-10 text-[13px] gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4c-.2 1.2-.9 2.3-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" /><path fill="currentColor" opacity=".8" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6C4.8 19.8 8.1 22 12 22z" /><path fill="currentColor" opacity=".6" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1C2.4 8.8 2 10.4 2 12s.4 3.2 1.1 4.6L6.4 14z" /><path fill="currentColor" opacity=".9" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9C17 2.9 14.7 2 12 2 8.1 2 4.8 4.2 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" /></svg>
            Continue with Google
          </a>
        )}
        <p className="text-[11.5px] text-dim leading-relaxed prose">Your code is cloned into your own space and your database credentials are stored encrypted. Only you can see your projects.</p>
      </div>
    </div>
  );
}
