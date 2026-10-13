"use client";
// Right panel: Inspect (what is selected on the map) or Ask (chat over the stack). Resizable.
import { cx } from "@/lib/ui";
import { Icon } from "@/components/ui";
import { Inspector } from "@/components/screens/inspector";
import { AskPane } from "@/components/panels/ask-pane";
import { ResizeHandle, useResizable } from "./resize";
import { useWorkspace } from "./workspace";

export function RightPanel() {
  const { rightPane, setRightPane, selection, section } = useWorkspace();
  const { size, handle } = useResizable("right", 380, { min: 300, max: 720, axis: "x", invert: true });
  const showInspect = section === "map";
  return (
    <div className="flex-none bg-surface border-l border-border flex flex-col min-h-0 relative" style={{ width: size }}>
      <ResizeHandle axis="x" className="left-0" {...handle} />
      <div className="h-9 flex-none flex items-center gap-1 px-2 border-b border-border">
        {showInspect && (["inspect", "ask"] as const).map((p) => (
          <button key={p} onClick={() => setRightPane(p)} className={cx("h-7 px-2.5 rounded-[5px] text-[12px] font-medium cursor-pointer flex items-center gap-1.5 transition", rightPane === p ? "bg-surface-3 text-text" : "text-muted hover:text-text")}>{p === "inspect" ? Icon.search({ size: 13 }) : Icon.chat({ size: 13 })}{p === "inspect" ? "Inspect" : "Ask"}</button>
        ))}
        {!showInspect && <span className="h-7 px-2.5 text-[12px] font-medium flex items-center gap-1.5 text-text">{Icon.chat({ size: 13 })} Ask</span>}
        <span className="flex-1" />
        <button className="btn-icon btn-xs text-dim" onClick={() => setRightPane(null)} title="Close panel" aria-label="Close panel">{Icon.close({ size: 13 })}</button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {rightPane === "inspect" && showInspect && (selection ? <Inspector /> : <div className="flex-1 flex items-center justify-center p-6 text-center text-[12.5px] text-dim leading-relaxed prose">Click a card on the map to see what it is, what it touches, and open its code.</div>)}
        {(rightPane === "ask" || !showInspect) && <AskPane />}
      </div>
    </div>
  );
}
