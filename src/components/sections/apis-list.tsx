"use client";
// Left pane of the APIs section: filter + the endpoint list (folders by first path segment once the
// list is long enough), active row highlighted, "+ New API" on the section header, "N APIs" footer with an
// optional slot (the "not published" chip).
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { PanelSection } from "@/components/shell/side-panel";
import { Icon, MethodBadge, SearchInput, Spinner } from "@/components/ui";
import type { GNode } from "@/lib/arkus/types";
import { cx, useLocal } from "@/lib/ui";

/** One 22px row: indent by depth, optional chevron, icon, mono name, dim meta on the right. */
function TreeRow({ depth = 0, icon, name, meta, active, onClick, chevron, title }: { depth?: number; icon?: ReactNode; name: ReactNode; meta?: ReactNode; active?: boolean; onClick?: () => void; chevron?: "open" | "closed" | null; title?: string }) {
  return (
    <div title={title} onClick={onClick} className={cx("tree-row", active && "active")} style={{ paddingLeft: 8 + depth * 12 }}>
      <span className={cx("w-3.5 flex-none text-dim flex items-center justify-center transition-transform", chevron === "open" && "rotate-90", chevron == null && "invisible")}>{Icon.chevron({ size: 12 })}</span>
      {icon && <span className="flex-none text-dim flex items-center">{icon}</span>}
      <span className="truncate font-mono text-[12px]">{name}</span>
      {meta != null && <span className="ml-auto pl-2 text-[11px] text-dim whitespace-nowrap flex-none">{meta}</span>}
    </div>
  );
}

/** Folder of an endpoint: first path segment after an optional leading "api" ("/api/keys" → "/api/keys", "/users/:id" → "/users"). */
export const groupOf = (n: GNode): string => {
  const path = epPath(n); const parts = path.split("/").filter(Boolean); const i = parts[0] === "api" ? 1 : 0; const seg = parts[i];
  return seg && !seg.startsWith(":") ? "/" + parts.slice(0, i + 1).join("/") : "/" + parts.slice(0, i).join("/");
};
export const epPath = (n: GNode) => String(n.attrs?.path || n.name.replace(/^[A-Z]+\s+/, ""));
export const epMethod = (n: GNode) => String(n.attrs?.method || n.name.split(" ")[0] || "GET").toUpperCase();
const Badge = ({ n }: { n: GNode }) => <MethodBadge method={epMethod(n)} className="w-[40px] h-[15px] text-[9.5px] px-0" />;

export function ApiList({ endpoints, active, onSelect, slug, loading, q, setQ, onNew, footer }: { endpoints: GNode[]; active: string | null; onSelect: (key: string) => void; slug: string; loading: boolean; q: string; setQ: (v: string) => void; onNew?: () => void; footer?: ReactNode }) {
  const [open, setOpen] = useLocal<Record<string, boolean>>("arkus:apis-folders", {});
  const ql = q.trim().toLowerCase();
  const list = useMemo(() => endpoints.filter((n) => !ql || epPath(n).toLowerCase().includes(ql) || n.name.toLowerCase().includes(ql)), [endpoints, ql]);
  const row = (n: GNode, depth: number) => (
    <TreeRow key={n.key} depth={depth} icon={<Badge n={n} />} name={epPath(n)} active={active === n.key} chevron={null} onClick={() => onSelect(n.key)} title={n.file ? `${n.file}${n.lineStart ? `:${n.lineStart}` : ""}` : n.name} />
  );
  const body = () => {
    if (loading) return <div className="px-4 py-2"><Spinner /></div>;
    if (!endpoints.length) return <div className="px-3 py-3 text-[12px] text-dim leading-relaxed">No APIs found yet · <Link className="link" href={`/import?project=${slug}`}>Analyse the code</Link></div>;
    if (!list.length) return <div className="px-3 py-3 text-[12px] text-dim">Nothing matches "{q}".</div>;
    if (endpoints.length <= 8) return list.map((n) => row(n, 0));
    const m = new Map<string, GNode[]>(); for (const n of list) { const g = groupOf(n); if (!m.has(g)) m.set(g, []); m.get(g)!.push(n); }
    const folders = [...m.entries()].filter(([, ns]) => ns.length >= 2).sort(([a], [b]) => a.localeCompare(b));
    const singles = [...m.entries()].filter(([, ns]) => ns.length < 2).flatMap(([, ns]) => ns).sort((a, b) => epPath(a).localeCompare(epPath(b)));
    return [
      ...folders.map(([g, ns]) => {
        const isOpen = !!ql || open[g] !== false;
        return (
          <div key={g}>
            <TreeRow depth={0} name={g} meta={ns.length} chevron={isOpen ? "open" : "closed"} icon={Icon.folder({ size: 13 })} onClick={() => setOpen((o) => ({ ...o, [g]: !(o[g] !== false) }))} />
            {isOpen && ns.map((n) => row(n, 1))}
          </div>
        );
      }),
      ...singles.map((n) => row(n, 0)),
    ];
  };
  return (
    <div className="w-[272px] flex-none bg-surface border-r border-border flex flex-col min-h-0">
      <div className="px-2 pt-2 pb-1.5 flex-none"><SearchInput value={q} onChange={setQ} placeholder="Filter APIs" /></div>
      <PanelSection title="APIs" count={endpoints.length} open onToggle={() => {}} grow right={onNew && <button className="btn-icon btn-xs w-6 dev-only" title="New API" aria-label="New API" onClick={onNew}>{Icon.plus({ size: 12 })}</button>}>
        {body()}
      </PanelSection>
      <div className="h-7 flex-none flex items-center gap-2 px-3 border-t border-border text-[11.5px] text-dim tabular-nums">
        <span className="truncate">{ql && list.length !== endpoints.length ? `${list.length} of ${endpoints.length} APIs` : `${endpoints.length} ${endpoints.length === 1 ? "API" : "APIs"}`}</span>
        <span className="flex-1" />
        {footer}
      </div>
    </div>
  );
}
