"use client";
// Who am I, and is this a hosted Arkus? Fetched once per page load and shared.
import { useEffect, useState } from "react";

export type MeInfo = { cloud: boolean; google: boolean; devLogin?: boolean; user: { id: string; email: string | null; name: string | null; image: string | null } | null };
let cache: MeInfo | null = null;
let inflight: Promise<MeInfo> | null = null;
export function fetchMe(): Promise<MeInfo> {
  if (cache) return Promise.resolve(cache);
  inflight ||= fetch("/api/auth/me").then((r) => r.json()).then((d: MeInfo) => { cache = d; return d; }).catch(() => ({ cloud: false, google: false, devLogin: false, user: null } as MeInfo));
  return inflight;
}
export function useMe(): MeInfo | null {
  const [me, setMe] = useState<MeInfo | null>(cache);
  useEffect(() => { let on = true; fetchMe().then((d) => { if (on) setMe(d); }); return () => { on = false; }; }, []);
  return me;
}
export async function signOut() { cache = null; inflight = null; await fetch("/api/auth/signout", { method: "POST" }); window.location.reload(); }
