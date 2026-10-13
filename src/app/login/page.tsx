"use client";
// Sign in (hosted Arkus only). Google is the only provider in V1.
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ArkusMark } from "@/components/shell/standalone";
import { useMe } from "@/lib/me";

export default function LoginPage() { return <Suspense><Login /></Suspense>; }

function Login() {
  const sp = useSearchParams();
  const me = useMe();
  const next = sp.get("next") || "/";
  const error = sp.get("error");
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
        {me?.google === false ? (
          <div className="w-full rounded-[7px] border border-amber/40 bg-amber/10 text-amber text-[12.5px] px-3 py-2 prose">Google sign-in is not configured on this server yet.</div>
        ) : (
          <a href={`/api/auth/google?next=${encodeURIComponent(next)}`} className="btn-primary w-full h-10 text-[13px] gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4c-.2 1.2-.9 2.3-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" /><path fill="currentColor" opacity=".8" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6C4.8 19.8 8.1 22 12 22z" /><path fill="currentColor" opacity=".6" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1C2.4 8.8 2 10.4 2 12s.4 3.2 1.1 4.6L6.4 14z" /><path fill="currentColor" opacity=".9" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9C17 2.9 14.7 2 12 2 8.1 2 4.8 4.2 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" /></svg>
            Continue with Google
          </a>
        )}
        <p className="text-[11.5px] text-dim leading-relaxed prose">Your code is cloned into your own space and your database credentials are stored encrypted. Only you can see your projects.</p>
      </div>
    </div>
  );
}
