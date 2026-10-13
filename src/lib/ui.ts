"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; } }

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init || {};
  // A body implies a mutation: default to POST unless the caller picked a method.
  if (json !== undefined && !rest.method) rest.method = "POST";
  const res = await fetch(url, { ...rest, headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers || {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError((data as { error?: string })?.error || res.statusText || "Request failed", res.status);
  return data as T;
}

/** Tiny data hook: fetch on mount / when url changes; `reload()` to refetch; `mutate(fn)` for optimistic edits. */
export function useApi<T = unknown>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const reload = useCallback(async (silent = false) => {
    if (!url) { setData(null); setLoading(false); return; }
    const my = ++seq.current;
    if (!silent) setLoading(true);
    try { const d = await api<T>(url); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError((e as Error).message); }
    finally { if (my === seq.current) setLoading(false); }
  }, [url]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [url, ...deps]);
  const mutate = useCallback((fn: (d: T | null) => T | null) => setData((d) => fn(d)), []);
  return { data, error, loading, reload, mutate, setData };
}

/** Subscribe to a POST SSE endpoint (used by the index stream). */
export function streamEvents(url: string, handlers: Record<string, (data: unknown) => void>, init?: RequestInit): { abort: () => void; done: Promise<void> } {
  const ac = new AbortController();
  const done = (async () => {
    const res = await fetch(url, { method: "POST", ...init, signal: ac.signal });
    if (!res.ok || !res.body) { handlers.error?.({ message: (await res.text()) || res.statusText }); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1] || "message";
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        try { handlers[ev]?.(data ? JSON.parse(data) : null); } catch { /* ignore */ }
      }
    }
  })().catch((e) => { if (e.name !== "AbortError") handlers.error?.({ message: e.message }); });
  return { abort: () => ac.abort(), done };
}

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
export const fmtNum = (n: number | undefined | null) => n == null ? "—" : n.toLocaleString();
export const timeAgo = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`;
};
export const methodColor = (m: string) => ({ GET: "text-green border-green/40 bg-green/10", POST: "text-accent border-accent/40 bg-accent/10", PUT: "text-amber border-amber/40 bg-amber/10", PATCH: "text-amber border-amber/40 bg-amber/10", DELETE: "text-red-soft border-red/40 bg-red/10" } as Record<string, string>)[m] || "text-muted border-border bg-surface-2";
/** useState mirrored to localStorage. Hydrates after mount (so SSR and the first paint agree); the setter
 * accepts a value or an updater, like setState, and updaters compose within one tick. */
export const useLocal = <T,>(key: string, initial: T) => {
  const [v, setV] = useState<T>(initial);
  useEffect(() => { try { const s = localStorage.getItem(key); if (s) setV(JSON.parse(s)); } catch { /* */ } }, [key]);
  const set = useCallback((nv: T | ((prev: T) => T)) => {
    setV((prev) => {
      const next = typeof nv === "function" ? (nv as (p: T) => T)(prev) : nv;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  }, [key]);
  return [v, set] as const;
};
