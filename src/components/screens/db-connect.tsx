"use client";
// ConnectDbModal: engine · connection string · schema-only toggle · staged test (DNS > TCP > Auth >
// Introspect, or File > Open > Introspect) · read-only role SQL · Cancel / Test / Connect.
// Connect only unlocks after a passing test. Nothing but the url ever leaves this dialog, and it
// is stored encrypted server-side; it is never shown again.
import { useEffect, useState } from "react";
import { useWorkspace, type Env } from "@/components/shell/workspace";
import { useMe } from "@/lib/me";
import { CopyButton, Field, Icon, Modal, Spinner, Toggle, useToast } from "@/components/ui";
import { cx, fmtNum } from "@/lib/ui";
import { dbBase, ENGINES, post, type ConnectResp, type Engine, type PublicSource, type TestResult, type TestStage } from "./db-shared";

const ROLE_SQL: Record<Engine, string> = {
  postgres: `-- run as a superuser on the target database\nCREATE ROLE arkus_ro LOGIN PASSWORD 'choose-a-strong-password';\nGRANT CONNECT ON DATABASE your_db TO arkus_ro;\nGRANT USAGE ON SCHEMA public TO arkus_ro;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO arkus_ro;\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO arkus_ro;\n-- then connect with postgres://arkus_ro:...@host:5432/your_db`,
  mysql: `-- run as root on the server\nCREATE USER 'arkus_ro'@'%' IDENTIFIED BY 'choose-a-strong-password';\nGRANT SELECT, SHOW VIEW ON your_db.* TO 'arkus_ro'@'%';\nFLUSH PRIVILEGES;\n-- then connect with mysql://arkus_ro:...@host:3306/your_db`,
  sqlite: `-- SQLite has no roles: Arkus opens the file read-only and only ever issues SELECTs.\n-- Keep the file outside your deploy bundle.`,
};

/** Engine implied by a pasted connection string, so the dropdown follows the paste. */
const detectEngine = (v: string): Engine | null => { const l = v.trim().toLowerCase(); if (/^postgres(ql)?:\/\//.test(l)) return "postgres"; if (/^mysql2?:\/\//.test(l)) return "mysql"; if (/^(file:|sqlite:)|\.(db|sqlite3?)$/.test(l)) return "sqlite"; return null; };

export function ConnectDbModal({ open, onClose, env, existing, onConnected }: { open: boolean; onClose: () => void; env: Env; existing?: PublicSource | null; onConnected?: (r: ConnectResp) => void | Promise<void> }) {
  const { project, reloadProject, reloadGraph } = useWorkspace();
  const { toast } = useToast();
  const base = dbBase(project.slug);
  const me = useMe();
  const [engine, setEngine] = useState<Engine>("postgres");
  const [url, setUrl] = useState("");
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const eng = ENGINES.find((e) => e.id === engine)!;

  useEffect(() => {
    if (!open) return;
    setEngine((existing?.engine as Engine) || (me?.cloud ? "postgres" : (project.stack?.dbEngineHint as Engine) || "postgres"));
    setSchemaOnly(!!existing?.schemaOnly); setUrl(""); setTest(null); setBusy(null); setRoleOpen(false);
  }, [open, existing, project.stack?.dbEngineHint]);

  const runTest = async () => {
    if (!url.trim()) return;
    setBusy("test"); setTest(null);
    try { const r = await post<TestResult>(`${base}/test`, { url, engine, schemaOnly }); setTest(r); }
    catch (e) { setTest({ ok: false, stages: [], error: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const connect = async () => {
    if (!test?.ok) return;
    setBusy("connect");
    try {
      const r = await post<ConnectResp>(`${base}/sources`, { url, engine, schemaOnly, env });
      if (r.test) setTest(r.test);
      if (!r.ok) { toast({ title: "Could not connect", detail: r.error || r.test?.stages.find((s) => !s.ok)?.error || r.source?.lastError || "connection failed", kind: "error" }); return; }
      const st = r.snapshot?.stats;
      toast({ title: `${eng.label} connected on ${env}`, detail: `${fmtNum(st?.tables)} tables · ${fmtNum(st?.columns)} columns · ${fmtNum(st?.fks)} foreign keys${r.snapshot?.reused ? " · schema unchanged" : ""}`, kind: "ok" });
      await Promise.all([reloadProject(), reloadGraph()]);
      await onConnected?.(r);
      onClose();
    } catch (e) { toast({ title: "Could not connect", detail: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  };

  const stages = test?.stages.length ? test.stages.map((s) => s.name) : eng.stages;
  const stageOf = (name: string): TestStage | undefined => test?.stages.find((s) => s.name === name);

  return (
    <Modal open={open} onClose={onClose} width={620} title={existing ? `Change the ${env} database` : `Connect the ${env} database`} subtitle="The connection string is encrypted on this machine and never shown again."
      footer={<>
        <button className="btn-ghost" onClick={onClose} disabled={busy === "connect"}>Cancel</button>
        <button className="btn-ghost" disabled={!url.trim() || !!busy} onClick={runTest}>{busy === "test" ? <Spinner /> : null} Test connection</button>
        <button className="btn-primary" disabled={!test?.ok || !!busy} title={test?.ok ? undefined : "Run the test first"} onClick={connect}>{busy === "connect" ? <Spinner /> : null} {existing ? "Replace" : "Connect"}</button>
      </>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[180px_1fr] gap-3">
          <Field label="Engine"><select className="select" value={engine} onChange={(e) => { setEngine(e.target.value as Engine); setTest(null); }}>{ENGINES.filter((e) => !(me?.cloud && e.id === "sqlite")).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
          <Field label="Connection string" hint={engine === "sqlite" ? "Relative paths resolve from the project folder." : "Use a SELECT-only login if you can (see below)."}>
            <input autoFocus className="input font-mono" value={url} onChange={(e) => { const v = e.target.value; setUrl(v); setTest(null); const guess = detectEngine(v); if (guess) setEngine(guess); }} placeholder={eng.placeholder} spellCheck={false} onKeyDown={(e) => { if (e.key === "Enter") runTest(); }} />
          </Field>
        </div>
        <Toggle checked={schemaOnly} onChange={(b) => { setSchemaOnly(b); setTest(null); }} label="Schema only" hint="Introspect tables and keys, never read rows. The data grid and queries stay off for this environment." />

        {(test || busy === "test") && (
          <div className="rounded-[6px] border border-border bg-bg-deep/40 p-3 flex flex-col gap-1.5 arise">
            {stages.map((name, i) => {
              const s = stageOf(name);
              const pending = busy === "test" && !s && (i === 0 || stageOf(stages[i - 1])?.ok);
              const skipped = !s && !!test && !pending;
              return (
                <div key={name} className="flex items-center gap-2.5 text-[13px] h-6">
                  <span className={cx("w-5 h-5 rounded-full border flex items-center justify-center flex-none", s?.ok ? "border-green/50 text-green bg-green/10" : s ? "border-red/50 text-red-soft bg-red/10" : "border-border text-dim")}>{s?.ok ? Icon.check({ size: 12 }) : s ? Icon.close({ size: 12 }) : pending ? <Spinner /> : <span className="text-[10px]">{i + 1}</span>}</span>
                  <span className={cx(s?.ok ? "text-text" : s ? "text-red-soft" : skipped ? "text-dim line-through" : "text-muted")}>{name}</span>
                  {s && <span className="text-[11.5px] text-dim ml-auto font-mono">{s.ms} ms</span>}
                </div>
              );
            })}
            {test?.stages.filter((s) => s.error).map((s) => <div key={s.name} className="text-[12.5px] text-red-soft bg-red/10 border border-red/30 rounded-[6px] px-2.5 py-1.5 mt-1 break-words">{s.name}: {s.error}</div>)}
            {test?.error && !test.stages.length && <div className="text-[12.5px] text-red-soft bg-red/10 border border-red/30 rounded-[6px] px-2.5 py-1.5 mt-1 break-words">{test.error}</div>}
            {test?.ok && <div className="text-[12.5px] text-green mt-1">Reachable · {fmtNum(test.tableCount)} tables{test.version ? ` · ${test.version.split(" ").slice(0, 2).join(" ")}` : ""}</div>}
          </div>
        )}

        <div className="border-t border-border pt-3">
          <button className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-text cursor-pointer" onClick={() => setRoleOpen((o) => !o)}>{Icon.chevron({ size: 12, className: cx("transition", roleOpen && "rotate-90") })} Recommended: a read-only role</button>
          {roleOpen && (
            <div className="mt-2 flex flex-col gap-2 arise">
              <div className="text-[12.5px] text-muted">Give Arkus its own SELECT-only login so the database enforces read-only too, not just Arkus.</div>
              <div className="relative"><pre className="bg-bg-deep border border-border rounded-[6px] p-3 pr-20 text-[12px] leading-[1.6] text-text-2 font-mono overflow-auto whitespace-pre">{ROLE_SQL[engine]}</pre><CopyButton text={ROLE_SQL[engine]} className="absolute top-1.5 right-1.5" /></div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
