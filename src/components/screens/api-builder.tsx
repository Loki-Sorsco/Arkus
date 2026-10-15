"use client";
// New API wizard: one screen, form on the left (method · path · purpose · table · fields · filters · login ·
// description), the generated route file on the right (POST /apis/generate, 400 ms debounce; a second,
// AI-polished pass follows when AI is on). "Create API" writes the file through PUT /file { baseHash: null }
// (409 when it exists), re-indexes the map and opens the new endpoint's Code tab.
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import { arkusTheme, useCmTheme } from "@/components/screens/cm-theme";
import { langExt } from "@/components/screens/code-editor";
import { useDbSchema } from "@/components/screens/db-shared";
import { useWorkspace } from "@/components/shell/workspace";
import { Chip, Field, Icon, Modal, Spinner, Tabs, Toggle, useToast } from "@/components/ui";
import { api, ApiError, cx, streamEvents } from "@/lib/ui";
import type { ApiSpec, Method, Purpose } from "@/lib/arkus/apigen";

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type Preview = { key: string; path: string; content: string; notes: string[]; exists: boolean; polished: boolean; loading: boolean; polishing: boolean; error: string | null };
const EMPTY: Preview = { key: "", path: "", content: "", notes: [], exists: false, polished: false, loading: false, polishing: false, error: null };
const PURPOSES: { id: Purpose; label: string; method: Method; hint: string }[] = [
  { id: "list", label: "List rows", method: "GET", hint: "Returns many rows, with optional filters" },
  { id: "get_one", label: "Get one row", method: "GET", hint: "Reads one row by its :id" },
  { id: "create", label: "Create a row", method: "POST", hint: "Takes a JSON body, inserts a row" },
  { id: "update", label: "Update a row", method: "PATCH", hint: "Changes the fields sent for one :id" },
  { id: "delete", label: "Delete a row", method: "DELETE", hint: "Removes one row by its :id" },
  { id: "custom", label: "Custom", method: "POST", hint: "An empty handler you fill in" },
];
const PATH_RE = /^\/[A-Za-z0-9_\-./:*]*$/;
const langOf = (p: string) => (p.endsWith(".py") ? "python" : p.endsWith(".js") ? "javascript" : "typescript");
const needsId = (p: Purpose) => p === "get_one" || p === "update" || p === "delete";
const endpointKey = (method: Method, path: string) => `endpoint:${method} ${path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")}`;

export function NewApiModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (key: string) => void }) {
  const { project, env, gate, reloadGraph } = useWorkspace();
  const { tables } = useDbSchema();
  const { toast } = useToast();
  const cmTheme = useCmTheme();
  const [method, setMethod] = useState<Method>("GET");
  const [path, setPath] = useState("/api/");
  const [purpose, setPurpose] = useState<Purpose>("list");
  const [table, setTable] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [filters, setFilters] = useState<string[]>([]);
  const [auth, setAuth] = useState(true);
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<Preview>(EMPTY);
  const [busy, setBusy] = useState<"create" | "index" | null>(null);
  const seq = useRef(0);

  useEffect(() => { if (open) { setMethod("GET"); setPath("/api/"); setPurpose("list"); setTable(""); setFields([]); setFilters([]); setAuth(true); setDescription(""); setPreview(EMPTY); setBusy(null); } }, [open]);
  const t = useMemo(() => tables.find((x) => x.name === table) || null, [tables, table]);
  const columns = useMemo(() => (t?.columns || []).filter((c) => !c.secret), [t]);
  const pickTable = (name: string) => { setTable(name); const cols = (tables.find((x) => x.name === name)?.columns || []).filter((c) => !c.secret).map((c) => c.name); setFields(cols); setFilters([]); };
  const pickPurpose = (p: Purpose) => { setPurpose(p); setMethod(PURPOSES.find((x) => x.id === p)!.method); if (needsId(p) && !/:\w+/.test(path)) setPath((cur) => (cur.replace(/\/$/, "") || "/api") + "/:id"); };

  const pathOk = PATH_RE.test(path) && path.length > 1 && !path.endsWith("/");
  const spec = useMemo<ApiSpec | null>(() => (pathOk ? { method, path, purpose, table: table || undefined, fields, filters: purpose === "list" ? filters : [], auth, description: description.trim() || undefined } : null), [pathOk, method, path, purpose, table, fields, filters, auth, description]);
  const key = spec ? JSON.stringify(spec) : "";

  // Template first (fast), then the AI-polished version replaces it while the form stays untouched.
  useEffect(() => {
    if (!open || !key) { setPreview(EMPTY); return; }
    const my = ++seq.current;
    setPreview((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(async () => {
      type Resp = { path: string; content: string; notes: string[]; exists: boolean; polished: boolean };
      try {
        const r = await api<Resp>(`/api/projects/${project.slug}/apis/generate`, { json: { env, spec: JSON.parse(key), polish: false } });
        if (my !== seq.current) return;
        setPreview({ key, ...r, loading: false, polishing: project.ai !== false, error: null });
        if (project.ai === false) return;
        const p = await api<Resp>(`/api/projects/${project.slug}/apis/generate`, { json: { env, spec: JSON.parse(key), polish: true } }).catch(() => null);
        if (my !== seq.current) return;
        setPreview((s) => (p && p.polished ? { ...s, content: p.content, notes: p.notes, polished: true, polishing: false } : { ...s, polishing: false }));
      } catch (e) { if (my === seq.current) setPreview({ ...EMPTY, key, loading: false, error: (e as Error).message }); }
    }, 400);
    return () => clearTimeout(timer);
  }, [open, key, project.slug, project.ai, env]);

  const ready = !!spec && preview.key === key && !preview.loading && !preview.error && !!preview.content;
  const extensions = useMemo(() => [arkusTheme, ...langExt(langOf(preview.path))], [preview.path]);
  const create = () => spec && ready && gate(async () => {
    setBusy("create");
    try { await api(`/api/projects/${project.slug}/file`, { method: "PUT", json: { path: preview.path, content: preview.content, baseHash: null } }); }
    catch (e) { toast({ kind: e instanceof ApiError && e.status === 409 ? "warn" : "error", title: e instanceof ApiError && e.status === 409 ? "That file already exists" : "Could not create the file", detail: (e as Error).message }); setBusy(null); return; }
    setBusy("index");
    let indexError: string | null = null;
    await streamEvents(`/api/projects/${project.slug}/index`, { error: (d) => { indexError = (d as { message?: string })?.message || "index failed"; } }).done;
    await reloadGraph();
    toast({ kind: indexError ? "warn" : "ok", title: `Created ${preview.path.split("/").pop()}`, detail: indexError ? `Saved, but re-indexing failed: ${indexError}` : `${spec.method} ${spec.path} is on the map.` });
    setBusy(null);
    onCreated?.(endpointKey(spec.method, spec.path));
    onClose();
  });

  const toggle = (list: string[], set: (v: string[]) => void, name: string) => set(list.includes(name) ? list.filter((x) => x !== name) : [...list, name]);
  return (
    <Modal open={open} onClose={onClose} width={1100} title="New API" subtitle={<span className="prose">Describe the endpoint; Arkus writes the route file in this project&apos;s style. Nothing is saved until you create it.</span>}
      footer={<>
        <span className="text-[12px] text-dim prose mr-auto self-center">{preview.exists ? <span className="text-amber">A file already exists at that path; change the path or edit it in the Code tab.</span> : project.repoUrl ? "After creating, publish it from the Code tab." : "The file is saved to the project folder."}</span>
        <button className="btn-ghost" onClick={onClose} disabled={!!busy}>Cancel</button>
        <button className="btn-primary dev-only" disabled={!ready || preview.exists || !!busy} onClick={create}>{busy ? <Spinner /> : Icon.plus({ size: 13 })} {busy === "index" ? "Re-indexing" : busy === "create" ? "Creating" : "Create API"}</button>
      </>}>
      <div className="grid grid-cols-[400px_minmax(0,1fr)] gap-5">
        <div className="flex flex-col gap-4 min-w-0">
          <div>
            <span className="label">Method and path</span>
            <div className="flex gap-2 items-start">
              <Tabs size="sm" value={method} onChange={setMethod} items={METHODS.map((m) => ({ id: m, label: m }))} className="flex-none mt-0.5" />
              <input className={cx("input input-sm font-mono flex-1 min-w-0", !pathOk && path.length > 1 && "border-red/50")} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/api/items/:id" autoFocus autoComplete="off" spellCheck={false} />
            </div>
            <span className="block text-[12px] text-dim mt-1 prose">Use <span className="font-mono">:id</span> for a parameter{needsId(purpose) && !/:\w+/.test(path) ? <span className="text-amber">; this purpose needs one, for example <span className="font-mono">{path.replace(/\/$/, "")}/:id</span></span> : null}.</span>
          </div>
          <div>
            <span className="label">What it does</span>
            <div className="grid grid-cols-2 gap-1.5">
              {PURPOSES.map((p) => (
                <label key={p.id} className={cx("flex items-start gap-2 px-2.5 py-1.5 rounded-[6px] border cursor-pointer", purpose === p.id ? "border-accent/50 bg-accent/5" : "border-border hover:border-border-strong")}>
                  <input type="radio" name="purpose" className="mt-[3px]" checked={purpose === p.id} onChange={() => pickPurpose(p.id)} />
                  <span className="min-w-0"><span className="block text-[12.5px] text-text">{p.label}</span><span className="block text-[11.5px] text-dim prose leading-snug">{p.hint}</span></span>
                </label>
              ))}
            </div>
          </div>
          <Field label="Table" hint={tables.length ? undefined : "No tables in the map yet; the handler is written without a database call."}>
            <select className="select input-sm font-mono" value={table} onChange={(e) => pickTable(e.target.value)}>
              <option value="">none</option>
              {tables.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </Field>
          {t && purpose !== "custom" && (
            <div>
              <span className="label">{purpose === "create" || purpose === "update" ? "Fields it accepts" : "Fields it returns"}<span className="text-dim font-normal"> · {fields.length} of {columns.length}</span></span>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-[150px] overflow-auto card px-2.5 py-2">
                {columns.map((c) => (
                  <label key={c.name} className="flex items-center gap-1.5 text-[12px] min-w-0 cursor-pointer"><input type="checkbox" checked={fields.includes(c.name)} onChange={() => toggle(fields, setFields, c.name)} /><span className="font-mono truncate">{c.name}</span><span className="text-dim text-[11px] truncate">{c.pk ? "pk" : c.type}</span></label>
                ))}
                {t.columns.length > columns.length && <span className="col-span-2 text-[11px] text-dim prose">Secret-named columns are never included.</span>}
              </div>
            </div>
          )}
          {t && purpose === "list" && (
            <div>
              <span className="label">Filters<span className="text-dim font-normal"> · query parameters</span></span>
              <div className="flex flex-wrap gap-1">{columns.map((c) => <Chip key={c.name} tone={filters.includes(c.name) ? "accent" : "muted"} className="font-mono cursor-pointer" onClick={() => toggle(filters, setFilters, c.name)}>{c.name}</Chip>)}</div>
            </div>
          )}
          <Toggle checked={auth} onChange={setAuth} label="Require login" hint="Reuses the project's auth helper when one is found; otherwise leaves a marked TODO." />
          <Field label="Description" hint="One line; becomes the comment at the top of the file."><input className="input input-sm" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Recent items for the dashboard" maxLength={300} /></Field>
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0 h-6">
            <span className="label mb-0 flex-none">File</span>
            {preview.path ? <span className="font-mono text-[12px] text-text-2 truncate" title={preview.path}>{preview.path}</span> : <span className="text-[12px] text-dim prose">Type a path to see the file.</span>}
            <span className="flex-1" />
            {preview.exists && <Chip tone="amber">exists</Chip>}
            {preview.polishing ? <Chip tone="muted"><Spinner /> matching style</Chip> : preview.polished ? <Chip tone="accent" title="Imports and error style adapted to an existing handler">AI styled</Chip> : null}
          </div>
          <div className={cx("card overflow-hidden h-[440px] transition-opacity", preview.loading && "opacity-60")}>
            {preview.error ? <div className="p-4 text-[12.5px] text-red-soft prose">{preview.error}</div>
              : preview.content ? <CodeMirror value={preview.content} height="440px" theme={cmTheme} extensions={extensions} readOnly editable={false} basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, searchKeymap: false }} />
              : <div className="h-full flex items-center justify-center text-[12.5px] text-dim">{preview.loading ? <Spinner /> : "The generated code appears here."}</div>}
          </div>
          {preview.notes.length > 0 && <ul className="text-[12px] text-muted prose flex flex-col gap-0.5 pl-4 list-disc">{preview.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      </div>
    </Modal>
  );
}
