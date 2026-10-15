"use client";
// Plain-English strip under a screen's toolbar for people who are new to the stack. Dismissable per
// screen; comes back from the "?" button. Copy lives here so every screen explains itself the same way.
import { useState } from "react";
import { Icon } from "@/components/ui";
import { cx, useLocal } from "@/lib/ui";

export const EXPLAIN = {
  map: { lead: "Your app as a map, left to right: the screens people see, the APIs those screens call, the tables where data is saved, and outside services.", points: ["Page: a screen in your app.", "API: the server code a page talks to.", "Table: where the data is stored.", "Click a box to see what it touches. Double-click to open it. Blast radius shows what would break if it changed."] },
  frontend: { lead: "Every screen in your app. Sketch is drawn from the code: the fields, buttons and the APIs each page calls. Live shows the real page when the app is running.", points: ["Pick a page on the left.", "Sketch never runs your code, so it works even when the app is not started.", "Live needs the app running; on your own machine Arkus can start it for you."] },
  apis: { lead: "Every API in your app. Pick one on the left. Explain says what it does in plain words, Code is the real file (edit and press Ctrl+S to save), Test sends a request and shows the answer.", points: ["GET reads data, POST creates, PUT/PATCH change, DELETE removes.", "\"Connected to\" lists the tables it reads or writes and the pages that call it.", "A change here is a change to your real code. Arkus keeps nothing hidden."] },
  database: { lead: "Your tables. Click one to see its rows (Data) or its columns (Structure). Change a cell, then press Apply to save it for real.", points: ["Data is the rows. Structure is the columns and their types.", "Query lets you ask a question in English or write SQL. Reads only, unless you Apply edits in Data.", "Secret columns such as passwords are never shown."] },
  health: { lead: "Arkus checked your code for common problems. Nothing here changes your code; each item says what to do.", points: ["High items first: these can leak data or break production.", "Open jumps to the file or screen. Explain asks AI to say it in simpler words."] },
} as const;
export type ExplainKey = keyof typeof EXPLAIN;

export function Explainer({ id }: { id: ExplainKey }) {
  const [seen, setSeen] = useLocal<Record<string, boolean>>("arkus:explain-seen", {});
  const [open, setOpen] = useState(false);
  const c = EXPLAIN[id];
  if (seen[id] && !open) return null;
  return (
    <div className={cx("flex-none border-b border-border bg-surface-2 text-[12.5px] text-text-2 arise", open ? "px-3 py-2.5" : "h-8 flex items-center gap-3 px-3")}>
      {open ? (
        <div className="flex flex-col gap-1.5 prose">
          <div className="flex items-start gap-2"><span className="text-accent mt-0.5">{Icon.bolt({ size: 13 })}</span><span className="flex-1 leading-relaxed">{c.lead}</span><button className="btn-subtle btn-xs" onClick={() => { setOpen(false); setSeen({ ...seen, [id]: true }); }}>Got it</button></div>
          <ul className="pl-6 flex flex-col gap-0.5 list-disc text-muted">{c.points.map((p) => <li key={p} className="leading-relaxed">{p}</li>)}</ul>
        </div>
      ) : (
        <>
          <span className="text-accent">{Icon.bolt({ size: 13 })}</span>
          <span className="truncate prose">{c.lead}</span>
          <button className="btn-subtle btn-xs ml-auto whitespace-nowrap" onClick={() => setOpen(true)}>Tell me more</button>
          <button className="btn-subtle btn-xs" onClick={() => setSeen({ ...seen, [id]: true })}>Got it</button>
        </>
      )}
    </div>
  );
}

/** "?" button for a toolbar: brings the explainer back after it was dismissed. */
export function HelpButton({ id }: { id: ExplainKey }) {
  const [seen, setSeen] = useLocal<Record<string, boolean>>("arkus:explain-seen", {});
  if (!seen[id]) return null;
  return <button className="btn-icon btn-xs text-dim" title="What is this screen?" aria-label="What is this screen?" onClick={() => setSeen({ ...seen, [id]: false })}><span className="text-[12px] font-semibold">?</span></button>;
}
