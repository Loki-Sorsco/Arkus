"use client";
// 36px title bar: project on the left, search in the middle, Ask on the right.
import Link from "next/link";
import { cx } from "@/lib/ui";
import { Icon, Kbd } from "@/components/ui";
import { useWorkspace } from "./workspace";
import { RoleAttr, UserMenu } from "./standalone";
import { HealthBadge } from "@/components/sections/health";
import { useLook } from "@/lib/theme";

export function TitleBar() {
  const { project, setPaletteOpen, rightPane, setRightPane } = useWorkspace();
  const { theme, toggleTheme } = useLook();
  return (
    <div className="h-9 flex-none grid grid-cols-[1fr_auto_1fr] items-center px-2 bg-bg-deep border-b border-border">
      <div className="flex items-center gap-1 min-w-0 text-[12.5px]">
        <Link href="/" className="px-2 h-7 rounded-[5px] hover:bg-surface-2 flex items-center text-muted" title="All projects">Arkus</Link>
        <span className="text-dim">/</span>
        <span className="px-2 h-7 flex items-center font-semibold truncate">{project.name}</span>
      </div>
      <button onClick={() => setPaletteOpen(true)} className="w-[380px] h-[26px] flex items-center gap-2 bg-surface border border-border hover:border-border-strong rounded-[6px] text-dim text-[12px] px-2.5 cursor-pointer" title="Search everything (Ctrl K)">
        {Icon.search({ size: 13 })}<span className="flex-1 text-left truncate">Find a page, API or table…</span><Kbd>Ctrl K</Kbd>
      </button>
      <div className="flex items-center justify-end gap-1">
        <RoleAttr />
        <HealthBadge />
        <button className="btn-icon btn-xs text-dim" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label="Toggle theme">{theme === "dark" ? Icon.sun({ size: 14 }) : Icon.moon({ size: 14 })}</button>
        {project.ai === false && <Link href={`/p/${project.slug}/settings`} className="text-[11px] text-dim hover:text-text px-2" title="Turn on AI under Settings">AI off</Link>}
        <button className={cx("btn-xs", rightPane === "ask" ? "btn-primary" : "btn-ghost")} onClick={() => setRightPane(rightPane === "ask" ? "closed" : "ask")} title="Ask about this app (Ctrl L)">{Icon.spark({ size: 12 })} Ask</button>
        <UserMenu compact />
      </div>
    </div>
  );
}
