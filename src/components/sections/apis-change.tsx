"use client";
// Change view of the APIs section: say what should change about one endpoint in plain words (quick-edit
// buttons fill the box), POST /apis/change returns the rewritten file, and the diff is shown for approval.
// "Apply change" writes it through PUT /file with the hash the proposal was based on (409 if the file moved).
import { useEffect, useState } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, EmptyState, Icon, Spinner, useToast } from "@/components/ui";
import { DiffView } from "@/components/ui-diff";
import { api, ApiError, cx } from "@/lib/ui";
import type { GNode } from "@/lib/arkus/types";

type Proposal = { path: string; baseHash: string; before: string; after: string; summary: string; notes: string[]; unchanged?: boolean };
const QUICK: { label: string; text: string }[] = [
  { label: "Add a field to the response", text: "Add the field <name> to the response (read it from the same table the handler already uses)." },
  { label: "Add a filter / query param", text: "Add an optional query parameter <name> that filters the results." },
  { label: "Require login", text: "Require the caller to be signed in, using the same auth helper the other handlers use; answer 401 otherwise." },
  { label: "Validate the input", text: "Validate the request body: required fields must be present and have the right type; answer 400 with a clear message when not." },
  { label: "Add pagination", text: "Add pagination with `limit` (default 50, max 200) and `offset` query parameters, and return the total count." },
  { label: "Return a better error", text: "When the row is not found or the input is invalid, return a JSON error with a clear message and the right status code instead of throwing." },
];

export function ApiChange({ ep, onApplied }: { ep: GNode; onApplied: () => void }) {
  const { project, env, gate, go } = useWorkspace();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"ask" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  useEffect(() => { setText(""); setProposal(null); setError(null); setBusy(null); }, [ep.key]);

  if (project.ai === false) return <EmptyState icon={Icon.spark()} title="Describe changes in words" hint={<span className="prose">Turn on AI under More → Settings → AI to describe changes in words; you can still edit the Code tab directly.</span>} action={<button className="btn-ghost" onClick={() => go("settings")}>Open Settings</button>} />;
  if (!ep.file || !project.rootPath) return <EmptyState title="No source file for this endpoint" hint="The map does not know which file handles this route, so there is nothing to change here." />;

  const ask = async () => {
    const request = text.trim(); if (!request || busy) return;
    setBusy("ask"); setError(null); setProposal(null);
    try { setProposal(await api<Proposal>(`/api/projects/${project.slug}/apis/change`, { json: { env, endpointKey: ep.key, request } })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const apply = () => proposal && gate(async () => {
    setBusy("apply");
    try {
      await api(`/api/projects/${project.slug}/file`, { method: "PUT", json: { path: proposal.path, content: proposal.after, baseHash: proposal.baseHash } });
      toast({ kind: "ok", title: `Changed ${proposal.path.split("/").pop()}`, detail: "Re-index the map to pick up structural changes." });
      setProposal(null); setText("");
      onApplied();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setError("The file changed on disk since this was proposed. Ask again to get a fresh version."); setProposal(null); }
      else setError((e as Error).message);
    } finally { setBusy(null); }
  });
  const fill = (t: string) => { setText(t); setProposal(null); setError(null); };

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="px-6 py-5 max-w-[920px] flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Quick edits</span>
          <div className="flex flex-wrap gap-1.5">{QUICK.map((q) => <button key={q.label} className={cx("btn-ghost btn-xs", text === q.text && "border-accent/50 text-text")} disabled={!!busy} onClick={() => fill(q.text)}>{q.label}</button>)}</div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Describe the change</span>
          <textarea className="textarea text-[13px] min-h-[84px]" rows={3} value={text} disabled={!!busy} placeholder={`What should ${ep.name} do differently? Replace <name> in a quick edit with the real field.`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void ask(); } }} />
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-dim prose">Edits <span className="font-mono text-text-2">{ep.file}</span> only. You see the diff before anything is saved.</span>
            <span className="flex-1" />
            <button className="btn-primary btn-xs dev-only" disabled={!!busy || !text.trim() || /<name>/.test(text)} title={/<name>/.test(text) ? "Replace <name> with the real field first" : undefined} onClick={() => void ask()}>{busy === "ask" ? <Spinner /> : Icon.spark({ size: 12 })} Propose change</button>
          </div>
        </div>
        {busy === "ask" && <div className="flex items-center gap-2 text-[12.5px] text-dim"><Spinner /> Reading the handler and rewriting it</div>}
        {error && <div className="text-[12.5px] text-red-soft prose border border-red/30 bg-red/5 rounded-[6px] px-3 py-2">{error}</div>}
        {proposal && (
          <div className="card p-3 flex flex-col gap-2.5">
            <div className="flex items-center gap-2"><Chip tone="blue">Code</Chip><span className="font-mono text-[12px] text-muted truncate">{proposal.path}</span><span className="flex-1" />{proposal.unchanged && <Chip tone="amber">no change</Chip>}</div>
            <p className="text-[13px] text-text-2 prose leading-relaxed">{proposal.summary}</p>
            <DiffView before={proposal.before} after={proposal.after} maxHeight={420} />
            {proposal.notes.length > 0 && <ul className="text-[12px] text-muted prose flex flex-col gap-0.5 pl-4 list-disc">{proposal.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            <div className="flex items-center gap-1.5">
              <span className="flex-1" />
              <button className="btn-ghost btn-xs" disabled={busy === "apply"} onClick={() => setProposal(null)}>Discard</button>
              <button className="btn-primary btn-xs dev-only" disabled={!!busy || !!proposal.unchanged} onClick={apply}>{busy === "apply" ? <Spinner /> : Icon.check({ size: 12 })} Apply change</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
