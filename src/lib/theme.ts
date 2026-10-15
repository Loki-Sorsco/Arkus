"use client";
// Look & feel: theme (dark | light) and font (clean = sans UI, terminal = mono UI). Stored in localStorage
// and applied as data attributes on <html>; the inline script in layout.tsx applies them before first paint.
import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
export type Font = "clean" | "terminal";
const KEY = "arkus:look";
type Look = { theme: Theme; font: Font };
const DEFAULT: Look = { theme: "light", font: "clean" };
const read = (): Look => { try { return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Look>) }; } catch { return DEFAULT; } };
const apply = (l: Look) => { const el = document.documentElement; el.dataset.theme = l.theme; el.dataset.font = l.font; el.style.colorScheme = l.theme; };
const listeners = new Set<(l: Look) => void>();

export function useLook() {
  const [look, setLook] = useState<Look>(DEFAULT);
  useEffect(() => { setLook(read()); const fn = (l: Look) => setLook(l); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  const update = (patch: Partial<Look>) => { const next = { ...read(), ...patch }; localStorage.setItem(KEY, JSON.stringify(next)); apply(next); listeners.forEach((fn) => fn(next)); };
  return { ...look, setTheme: (theme: Theme) => update({ theme }), setFont: (font: Font) => update({ font }), toggleTheme: () => update({ theme: read().theme === "dark" ? "light" : "dark" }) };
}
/** Inline script source for <head>: applies the saved look before React renders (no flash). */
export const LOOK_BOOT = `(function(){try{var k=${JSON.stringify(KEY)};var l=JSON.parse(localStorage.getItem(k)||"{}");var q=new URLSearchParams(location.search);if(q.get("theme")==="light"||q.get("theme")==="dark"){l.theme=q.get("theme");localStorage.setItem(k,JSON.stringify(l));}var t=l.theme==="dark"?"dark":"light";var f=l.font==="terminal"?"terminal":"clean";var e=document.documentElement;e.dataset.theme=t;e.dataset.font=f;e.style.colorScheme=t;}catch(e){}})();`;
