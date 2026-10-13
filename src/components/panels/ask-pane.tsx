"use client";
// Ask: grounded chat over the project's map. Lives in the right panel (360px) and in the "ask" tab
// (wide). History is per project in localStorage; `askDraft` from the workspace sends a question once.
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, Icon, Markdown, Ref, Spinner } from "@/components/ui";
import { api, cx, useLocal } from "@/lib/ui";
import type { AskCitation, AskResult } from "@/lib/arkus/ask";
import { refKind } from "@/components/tabs/writeup-view";

type Msg = { id: string; role: "user" | "assistant"; content: string; citations?: AskCitation[]; mode?: "ai" | "search" | "error"; at: number };
const EXAMPLES = ["How does sign up work?", "Where is a user's email stored?", "Which pages can change the Project table?", "What calls external services?", "What happens when I delete an API key?", "What would break if I rename User.name?"];
const MAX = 30;
const uid = () => Math.random().toString(36).slice(2);

export function AskPane() {
  const { project, askDraft, openNode, openTab, select } = useWorkspace();
  const [msgs, setMsgs] = useLocal<Msg[]>(`arkus:${project.slug}:ask`, []);
  const msgsRef = useRef(msgs);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const sentDraft = useRef<string | null>(null);

  const send = useCallback(async (q: string) => {
    const question = q.trim(); if (!question || busy) return;
    const history = msgsRef.current.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const push = (m: Omit<Msg, "id" | "at">) => setMsgs((cur) => [...cur, { ...m, id: uid(), at: Date.now() }].slice(-MAX));
    push({ role: "user", content: question });
    setInput(""); setBusy(true);
    try {
      const r = await api<AskResult>(`/api/projects/${project.slug}/ask`, { json: { question, history } });
      push({ role: "assistant", content: r.answer, citations: r.citations, mode: r.mode });
    } catch (e) {
      push({ role: "assistant", content: `Could not answer: ${(e as Error).message}`, mode: "error" });
    } finally { setBusy(false); }
  }, [busy, project.slug, setMsgs]);

  // A question handed over from elsewhere (openAsk("...")) is sent once; deferred a tick so the
  // stored history has hydrated before the new message is appended to it.
  useEffect(() => {
    if (!askDraft || sentDraft.current === askDraft) return;
    sentDraft.current = askDraft; setInput(askDraft);
    const t = setTimeout(() => void send(askDraft), 0);
    return () => clearTimeout(t);
  }, [askDraft, send]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy]);

  const showOnMap = (key: string) => { openTab({ kind: "map", label: "Map" }); select(key); };
  const aiOff = project.ai === false;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-8 flex-none flex items-center gap-2 px-3 border-b border-border text-[12px]">
        {aiOff && <Chip tone="amber" onClick={() => openTab({ kind: "settings", label: "Settings" })} title="Answers fall back to search until an AI key is set">AI off · turn on</Chip>}
        {!aiOff && <span className="text-dim truncate">Answers cite the map; click a source to open it.</span>}
        <span className="flex-1" />
        <button className="btn-subtle btn-xs" disabled={!msgs.length} onClick={() => confirm("Clear this conversation?") && setMsgs([])}>Clear</button>
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-3 select-text">
        {!msgs.length && (
          <div className="flex flex-col gap-3 pt-2">
            <div className="text-[12.5px] text-muted leading-relaxed prose">Ask anything about how this app works. Answers are grounded in the indexed pages, APIs and tables{aiOff ? "; with AI off you get the matching parts of the map" : ""}.</div>
            <div className="flex flex-wrap gap-1.5">{EXAMPLES.map((q) => <Chip key={q} tone="muted" className="h-auto py-1 whitespace-normal text-left cursor-pointer hover:border-border-strong hover:text-text" onClick={() => void send(q)}>{q}</Chip>)}</div>
          </div>
        )}
        {msgs.map((m) => m.role === "user" ? (
          <div key={m.id} className="self-end max-w-[88%] rounded-[8px] rounded-br-[3px] bg-surface-3 px-2.5 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
        ) : (
          <div key={m.id} className="border-t border-border pt-2.5 flex flex-col gap-2">
            <Markdown text={m.content} className={cx("prose text-[13px] [&_p]:text-[13px] [&_li]:text-[13px]", m.mode === "error" && "[&_p]:text-red-soft")} />
            {!!m.citations?.length && (
              <div className="flex flex-col gap-1">
                <span className="text-[10.5px] uppercase tracking-[.06em] text-dim">Sources</span>
                <div className="flex flex-wrap gap-1">{m.citations.map((c) => <Ref key={c.key} kind={refKind(c.type)} onClick={() => openNode(c.key)}>{c.name}</Ref>)}</div>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              {!!m.citations?.length && <button className="btn-subtle btn-xs -ml-2" onClick={() => showOnMap(m.citations![0].key)}>{Icon.map({ size: 12 })} Show on map</button>}
              <span className="flex-1" />
              {m.mode && m.mode !== "error" && <Chip tone={m.mode === "ai" ? "accent" : "muted"}>{m.mode === "ai" ? "AI" : "search"}</Chip>}
            </div>
          </div>
        ))}
        {busy && <div className="border-t border-border pt-2.5 flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> Reading the map</div>}
      </div>
      <div className="flex-none border-t border-border p-2 flex gap-2 items-end bg-surface">
        <textarea className="textarea text-[12.5px] py-1.5 px-2.5 resize-none flex-1 min-w-0" rows={2} placeholder="Ask about this app… Enter to send, Shift+Enter for a new line" value={input} disabled={busy} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
        <button className="btn-primary btn-xs h-7" disabled={busy || !input.trim()} onClick={() => void send(input)}>{busy ? <Spinner /> : "Send"}</button>
      </div>
    </div>
  );
}
