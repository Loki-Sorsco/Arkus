"use client";
// Left rail: the three sections (Map · APIs · Database) as labelled icons, Ask, and a "More" menu for
// the rest (Flows, Plans, Activity, Connections, Settings).
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/lib/ui";
import { Icon } from "@/components/ui";
import { ArkusMark } from "./standalone";
import { useWorkspace, type Section } from "./workspace";

const MAIN: { id: Section; label: string; icon: ReactNode; key: string }[] = [
  { id: "map", label: "Map", icon: Icon.map({ size: 20 }), key: "1" },
  { id: "apis", label: "APIs", icon: Icon.api({ size: 20 }), key: "2" },
  { id: "database", label: "Database", icon: Icon.db({ size: 20 }), key: "3" },
];
const MORE: { id: Section; label: string; icon: ReactNode; hint?: string }[] = [
  { id: "flows", label: "Flows", icon: Icon.flow({ size: 14 }), hint: "user journeys" },
  { id: "plans", label: "Plans", icon: Icon.spark({ size: 14 }), hint: "drafted changes" },
  { id: "activity", label: "Activity", icon: Icon.activity({ size: 14 }), hint: "everything that happened" },
  { id: "connect", label: "Connections", icon: Icon.link({ size: 14 }), hint: "repo and databases" },
  { id: "settings", label: "Settings", icon: Icon.settings({ size: 14 }), hint: "AI key, export, remove" },
];

export function Rail() {
  const { section, project, rightPane, setRightPane } = useWorkspace();
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!more) return; const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMore(false); }; window.addEventListener("mousedown", h); return () => window.removeEventListener("mousedown", h); }, [more]);
  const dbOk = project.sources.some((s) => s.kind === "db" && s.status === "ok");
  const moreActive = MORE.some((m) => m.id === section);
  return (
    <div className="flex-none w-[60px] bg-bg-deep border-r border-border flex flex-col items-center py-1">
      <Link href="/" className="w-full h-11 flex items-center justify-center hover:bg-surface-2 transition" title="All projects"><ArkusMark size={22} /></Link>
      <div className="h-2" />
      {MAIN.map((m) => (
        <Link key={m.id} href={`/p/${project.slug}/${m.id}`} title={`${m.label} (Ctrl ${m.key})`} className={cx("relative w-full h-[54px] flex flex-col items-center justify-center gap-1 transition-colors", section === m.id ? "text-text" : "text-dim hover:text-text")}>
          {section === m.id && <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-accent rounded-r" />}
          <span className={cx(section === m.id && "text-accent")}>{m.icon}</span>
          <span className="text-[10px] tracking-wide">{m.label}</span>
          {m.id === "database" && <span className={cx("absolute top-2 right-3 w-1.5 h-1.5 rounded-full", dbOk ? "bg-green" : "bg-dim")} title={dbOk ? "database connected" : "no database"} />}
        </Link>
      ))}
      <div className="flex-1" />
      <button onClick={() => setRightPane(rightPane === "ask" ? null : "ask")} title="Ask AI (Ctrl L)" className={cx("w-full h-[54px] flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors", rightPane === "ask" ? "text-accent" : "text-dim hover:text-text")}>
        {Icon.chat({ size: 20 })}<span className="text-[10px] tracking-wide">Ask</span>
      </button>
      <div ref={ref} className="relative w-full">
        <button onClick={() => setMore((o) => !o)} title="More" className={cx("w-full h-[54px] flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors", moreActive || more ? "text-text" : "text-dim hover:text-text")}>
          <span className="relative">{Icon.settings({ size: 20 })}{project.draftPlans > 0 && <span className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-accent text-bg-deep text-[9px] font-bold flex items-center justify-center px-0.5">{project.draftPlans}</span>}</span>
          <span className="text-[10px] tracking-wide">More</span>
        </button>
        {more && (
          <div className="absolute left-[58px] bottom-1 w-[220px] card py-1 shadow-[0_12px_32px_rgba(0,0,0,.55)] z-30 arise">
            {MORE.map((m) => (
              <Link key={m.id} href={`/p/${project.slug}/${m.id}`} onClick={() => setMore(false)} className={cx("flex items-center gap-2.5 px-3 h-8 text-[12.5px] hover:bg-surface-3", section === m.id ? "text-text" : "text-text-2")}>
                <span className="text-dim">{m.icon}</span><span>{m.label}</span>{m.id === "plans" && project.draftPlans > 0 && <span className="chip h-[16px] px-1 text-[10px] text-accent border-accent/40 bg-accent/10">{project.draftPlans}</span>}<span className="ml-auto text-[10.5px] text-dim">{m.hint}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
