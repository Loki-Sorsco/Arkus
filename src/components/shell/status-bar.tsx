"use client";
// 22px status bar. Left: environment · database · index age. Right: cursor · AI · Local.
import { cx, timeAgo } from "@/lib/ui";
import { Icon } from "@/components/ui";
import { useWorkspace, type Env } from "./workspace";

export function StatusBar() {
  const { project, env, setEnv, graph, editorStatus, go, setRightPane } = useWorkspace();
  const db = project.sources.find((s) => s.kind === "db" && s.env === env);
  const dbOk = db?.status === "ok";
  const prod = env === "prod";
  const item = "h-full px-2 flex items-center gap-1.5 text-[11.5px] whitespace-nowrap";
  const click = "cursor-pointer hover:bg-white/10";
  return (
    <div className={cx("h-[22px] flex-none flex items-stretch border-t text-text-2", prod ? "bg-[#4a1f1f] border-red/40 text-red-soft" : "bg-surface-2 border-border")}>
      <div className="flex items-stretch">
        {(["dev", "preview", "prod"] as Env[]).map((e) => (
          <button key={e} onClick={() => setEnv(e)} className={cx(item, click, "font-medium capitalize", env === e ? (e === "prod" ? "bg-red/30 text-text" : "bg-accent text-bg-deep hover:bg-accent-hover") : "text-muted")} title={`Switch to ${e}`}>{e}</button>
        ))}
      </div>
      <button className={cx(item, click)} onClick={() => go("connect")} title={db ? `${db.name} · ${db.status}` : `No ${env} database connected. Click to connect one.`}>
        <span className={cx("w-1.5 h-1.5 rounded-full", dbOk ? "bg-green" : db ? "bg-amber" : "bg-dim")} />
        <span className="font-mono">{db ? String((db.config as { engine?: string })?.engine || db.name) : "no database"}</span>
      </button>
      {graph?.createdAt && <button className={cx(item, click)} onClick={() => go("map")} title="Last index">{Icon.refresh({ size: 11 })} indexed {timeAgo(graph.createdAt)}</button>}
      <div className="flex-1" />
      {editorStatus && <span className={item}>Ln {editorStatus.line}, Col {editorStatus.col}</span>}
      {editorStatus && <span className={item}>{editorStatus.language}</span>}
      <button className={cx(item, click)} onClick={() => project.ai === false ? go("settings") : setRightPane("ask")} title={project.ai === false ? "AI is off. Turn on AI under Settings." : "AI is on"}>{Icon.spark({ size: 11 })} {project.ai === false ? "AI off" : "AI"}</button>
      <span className={cx(item, "text-dim")}>Local</span>
    </div>
  );
}
