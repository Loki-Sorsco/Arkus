"use client";
// Tree helpers used by the list panes: collapsible sections and 22px tree rows.
import type { ReactNode } from "react";
import { cx } from "@/lib/ui";
import { Icon } from "@/components/ui";

/** Collapsible section inside a side panel (VS Code "view"): 22px header, uppercase title, count. */
export function PanelSection({ title, count, open, onToggle, right, children, grow }: { title: ReactNode; count?: number; open: boolean; onToggle: () => void; right?: ReactNode; children: ReactNode; grow?: boolean }) {
  return (
    <div className={cx("flex flex-col border-t border-border first:border-t-0", open && grow ? "flex-1 min-h-0" : "flex-none")}>
      <div className="group/sec h-[26px] flex-none flex items-center gap-1 pl-1.5 pr-2 cursor-pointer hover:bg-surface-2 select-none" onClick={onToggle}>
        <span className={cx("text-dim transition-transform", open ? "rotate-90" : "")}>{Icon.chevron({ size: 12 })}</span>
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-text-2 truncate">{title}</span>
        {count != null && <span className="text-[11px] text-dim tabular-nums">{count}</span>}
        <span className="flex-1" />
        <span className="opacity-0 group-hover/sec:opacity-100 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open && <div className={cx("pb-1", grow && "flex-1 min-h-0 overflow-auto")}>{children}</div>}
    </div>
  );
}

/** One row in a tree: 22px, indent by depth, optional chevron, mono name, dim meta on the right. */
export function TreeRow({ depth = 0, icon, name, meta, active, onClick, onDoubleClick, chevron, mono = true, title, className, dot }: { depth?: number; icon?: ReactNode; name: ReactNode; meta?: ReactNode; active?: boolean; onClick?: () => void; onDoubleClick?: () => void; chevron?: "open" | "closed" | null; mono?: boolean; title?: string; className?: string; dot?: ReactNode }) {
  return (
    <div title={title} onClick={onClick} onDoubleClick={onDoubleClick} className={cx("tree-row", active && "active", className)} style={{ paddingLeft: 8 + depth * 12 }}>
      <span className={cx("w-3.5 flex-none text-dim flex items-center justify-center transition-transform", chevron === "open" && "rotate-90", chevron == null && "invisible")}>{Icon.chevron({ size: 12 })}</span>
      {icon && <span className="flex-none text-dim flex items-center">{icon}</span>}
      {dot}
      <span className={cx("truncate", mono ? "font-mono text-[12px]" : "text-[12.5px]")}>{name}</span>
      {meta && <span className="ml-auto pl-2 text-[11px] text-dim whitespace-nowrap flex-none">{meta}</span>}
    </div>
  );
}
