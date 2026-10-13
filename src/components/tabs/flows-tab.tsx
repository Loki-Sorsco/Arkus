"use client";
// Flows tab: the flow picked in the side panel (tab.key) as a left-to-right storyline
// page → API(s) → tables → services, readable in Plain or Technical mode. Every step opens its node.
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import type { Tab } from "@/components/shell/tabs";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import { EXPLAIN_ITEMS, useExplain, useFlows } from "@/components/panels/flows";
import { Chip, Confidence, Dot, EmptyState, Icon, MethodBadge, Panel, Ref, Spinner, Tabs } from "@/components/ui";
import { cx } from "@/lib/ui";
import type { Flow } from "@/lib/arkus/flows";

const KIND_LABEL: Record<Flow["kind"], string> = { auth: "sign in & accounts", action: "action", admin: "admin action", display: "browse" };

export function FlowsTab({ tab }: { tab: Tab }) {
  const { graph, graphLoading, project, openNode, openFile, updateTab } = useWorkspace();
  const { flows, loading, snapshotId } = useFlows();
  const [explain, setExplain] = useExplain();
  const flow = flows.find((f) => f.id === tab.key) || flows[0] || null;
  // No (or stale) selection: fall back to the first flow and record it so the side panel highlights it.
  useEffect(() => { if (flow && flow.id !== tab.key) updateTab(tab.id, { key: flow.id }); }, [flow, tab.id, tab.key, updateTab]);
  const plain = explain === "plain";

  if (!flow) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {loading || graphLoading ? <div className="flex-1 flex items-center justify-center"><Spinner /></div>
          : !graph?.snapshotId && !snapshotId
            ? <EmptyState icon={Icon.flow()} title="No map yet" hint="Analyse the code once and Arkus will show what people can do in the app, step by step." action={<Link href={`/import?project=${project.slug}`} className="btn-primary">Analyse the code</Link>} />
            : <EmptyState icon={Icon.flow()} title="No flows yet" hint="Arkus found pages, but none of them call an API it recognises, so there is no storyline to show." />}
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title={flow.title} meta={KIND_LABEL[flow.kind]} right={<>
        <Tabs size="sm" value={explain} onChange={setExplain} items={EXPLAIN_ITEMS} />
        <button className="btn-subtle btn-xs" onClick={() => openNode(flow.page.key)}>{Icon.map({ size: 13 })} Open in map</button>
      </>} />
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="px-6 py-5 flex flex-col gap-4 max-w-[1100px]">
          <p className="text-[13px] text-muted leading-relaxed prose">{flow.summary}</p>
          <Panel pad={false}><Storyline flow={flow} plain={plain} onOpen={openNode} /></Panel>

          <Panel title="What happens" right={<span className="flex items-center gap-2">{flow.source === "ai" && <Chip tone="purple">{Icon.spark({ size: 11 })} named by AI</Chip>}<Confidence value={flow.confidence} /></span>}>
            <ol className="flex flex-col gap-3">
              {flow.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-5 h-5 rounded-full bg-surface-2 border border-border text-[11px] text-muted flex items-center justify-center flex-none mt-0.5 tabular-nums">{i + 1}</span>
                  <span className={cx("flex-1 min-w-0 leading-relaxed", plain ? "text-[13px] text-text-2 prose" : "text-[12.5px] font-mono text-text-2 break-words")}>{plain ? s.plain : s.technical}</span>
                </li>
              ))}
            </ol>
            {flow.alsoFrom.length > 0 && <div className="mt-4 text-[12.5px] text-dim">Also reachable from {flow.alsoFrom.map((p, i) => <span key={p.key}>{i > 0 && ", "}<span className="font-mono text-muted cursor-pointer hover:text-text" onClick={() => openNode(p.key)}>{p.name}</span></span>)}.</div>}
          </Panel>

          {flow.fields.length > 0 && (
            <Panel title="Data captured" right={<span className="text-[12px] text-dim font-normal">{plain ? "what the form asks for, and where it ends up" : "field → key → column"}</span>} pad={false}>
              <table className="tbl">
                <thead><tr><th>Field</th>{!plain && <th>Key</th>}<th>{plain ? "Saved in" : "Column"}</th></tr></thead>
                <tbody>
                  {flow.fields.map((f, i) => (
                    <tr key={i}>
                      <td className="font-medium">{f.label}</td>
                      {!plain && <td>{f.keyName ? <span className="font-mono">{f.keyName}</span> : <span className="text-dim">—</span>}</td>}
                      <td>{f.column ? (plain ? <span className="text-text-2">{f.column.split(".")[0]} <span className="text-dim">({f.column.split(".")[1]})</span></span> : <Ref kind="column" onClick={() => openNode(`table:${f.column!.split(".")[0]}`)}>{f.column}</Ref>) : <span className="text-dim text-[12.5px]">{plain ? "not stored" : "—"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          <Panel title="Evidence" right={<span className="text-[12px] text-dim font-normal">{plain ? "where this comes from in the code" : "file:line"}</span>} pad={false}>
            {flow.evidence.length ? flow.evidence.map((e, i) => (
              <div key={i} className="list-row cursor-default hover:bg-transparent">
                <span className="text-[13px] text-text-2 whitespace-nowrap">{e.label}</span>
                <span className="font-mono text-[12px] text-muted truncate cursor-pointer hover:text-text" title="Open file" onClick={() => openFile(e.file, e.line)}>{e.file}{e.line ? `:${e.line}` : ""}</span>
                {e.screen && e.sel && <button className="ml-auto link text-[12.5px] whitespace-nowrap" onClick={() => openNode(e.sel!)}>{e.screen === "pages" ? "Open page" : "Open API"}</button>}
              </div>
            )) : <div className="px-4 py-3 text-[12.5px] text-dim">No file references recorded for this flow.</div>}
            {flow.confidence < 0.9 && <div className="px-4 py-3 border-t border-border text-[12.5px] text-amber flex items-center gap-2">{Icon.warn({ size: 13 })} {flow.confidence <= 0.5 ? "Linked by matching names, not by a call Arkus could trace." : "Part of this storyline was inferred."}</div>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- storyline

function Card({ children, className, onClick, title }: { children: ReactNode; className?: string; onClick?: () => void; title?: string }) {
  return <div title={title} onClick={onClick} className={cx("card px-3 py-2.5 w-[210px] flex flex-col gap-1 min-h-[52px] justify-center", onClick && "cursor-pointer hover:border-border-strong hover:bg-surface-2 transition", className)}>{children}</div>;
}
function Column({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-2 flex-none"><div className="eyebrow h-4">{label}</div><div className="flex flex-col gap-2 justify-center flex-1">{children}</div></div>;
}
const Connector = () => <div className="flex-none w-8 self-stretch flex items-center pt-6" aria-hidden><div className="h-px w-full bg-border-strong" /></div>;

function Storyline({ flow, plain, onOpen }: { flow: Flow; plain: boolean; onOpen: (key: string) => void }) {
  const writes = flow.tables.filter((t) => t.op === "writes");
  const reads = flow.tables.filter((t) => t.op === "reads");
  const fieldCount = flow.fields.length;
  return (
    <div className="p-5 overflow-x-auto">
      <div className="flex items-stretch min-w-max">
        <Column label="Page">
          <Card onClick={() => onOpen(flow.page.key)} title="Open page">
            <div className="flex items-center gap-2 min-w-0"><Dot color="gold" /><span className={cx("text-[13px] font-medium truncate", !plain && "font-mono")}>{plain ? flow.page.label : flow.page.name}</span></div>
            <div className="text-[12px] text-dim truncate">{plain ? (fieldCount ? `${fieldCount} field${fieldCount === 1 ? "" : "s"} to fill in` : flow.kind === "display" ? "shows information" : "one click") : (flow.page.file || "file unknown")}</div>
          </Card>
        </Column>
        <Connector />
        <Column label={plain ? "What the app does" : "Endpoints"}>
          {flow.endpoints.map((ep) => (
            <Card key={ep.key} onClick={() => onOpen(ep.key)} title="Open API">
              {plain
                ? <><div className="text-[13px] font-medium">{ep.title}</div><div className="text-[12px] text-dim truncate">{ep.writes.length ? `${ep.method === "POST" ? "saves" : ep.method === "DELETE" ? "removes" : "updates"} ${ep.writes.length === 1 ? ep.writes[0] : ep.writes.length + " things"}` : ep.reads.length ? "looks things up" : "runs on the server"}</div></>
                : <><div className="flex items-center gap-2 min-w-0"><MethodBadge method={ep.method} className="w-[52px] text-[10.5px] h-[18px]" /><span className="font-mono text-[12.5px] truncate">{ep.path}</span></div><div className="text-[11.5px] text-dim font-mono truncate">{ep.bodyKeys.length ? `body: ${ep.bodyKeys.join(", ")}` : ep.auth === true ? "auth required" : ep.auth === false ? "public" : "no body"}</div></>}
            </Card>
          ))}
        </Column>
        <Connector />
        <Column label={plain ? "What gets saved or read" : "Tables"}>
          {[...writes, ...reads].map((t) => (
            <Card key={t.key + t.op} className="min-h-[40px] py-2" onClick={() => onOpen(t.key)} title="Open table">
              <div className="flex items-center gap-2 min-w-0"><Dot color="teal" /><span className={cx("text-[13px] truncate", !plain && "font-mono text-[12.5px]")}>{t.name}</span><Chip tone={t.op === "writes" ? "amber" : "muted"} className="ml-auto">{t.op}</Chip></div>
            </Card>
          ))}
          {!flow.tables.length && <Card className="border-dashed"><div className="text-[12.5px] text-dim">{plain ? "Nothing saved that Arkus can see" : "no tables linked"}</div></Card>}
        </Column>
        {flow.externals.length > 0 && (
          <>
            <Connector />
            <Column label={plain ? "Outside services" : "Externals"}>
              {flow.externals.map((x) => <Card key={x.key} className="min-h-[40px] py-2" onClick={() => onOpen(x.key)}><div className="flex items-center gap-2 min-w-0"><Dot color="purple" /><span className={cx("text-[13px] truncate", !plain && "font-mono text-[12.5px]")}>{x.name}</span></div></Card>)}
            </Column>
          </>
        )}
      </div>
    </div>
  );
}
