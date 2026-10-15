"use client";
// Hosted-mode import: pick a folder in the browser, upload its files (dependencies and build output
// skipped client-side), then hand the new project's slug back so the caller can run the analysis.
import { useRef, useState } from "react";
import { Icon, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/ui";

const SKIP = new Set(["node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage", ".turbo", ".cache", ".venv", "venv", "__pycache__", "vendor", "target", ".idea", ".vscode", ".expo", "Pods", ".DS_Store"]);
const MAX_FILE = 2 * 1024 * 1024;
const fmt = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function UploadFolder({ onDone }: { onDone: (slug: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pick = (list: FileList | null) => {
    if (!list) return;
    const all = Array.from(list);
    const keep = all.filter((f) => { const parts = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).split("/"); return !parts.some((p) => SKIP.has(p)) && f.size <= MAX_FILE; });
    const top = ((all[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || "").split("/")[0] || "";
    setFiles(keep); setFolder(top); setErr(null); if (!name) setName(top);
  };
  const total = files.reduce((s, f) => s + f.size, 0);
  const upload = async () => {
    if (!files.length) return;
    setBusy("Uploading"); setErr(null);
    const fd = new FormData();
    fd.set("name", name.trim() || folder);
    for (const f of files) fd.append("files", f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    try {
      const res = await fetch("/api/projects/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data.error || res.statusText, res.status);
      onDone(data.slug);
    } catch (e) { setErr((e as Error).message); setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-3">
      {/* webkitdirectory is what lets a browser hand over a whole folder */}
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => pick(e.target.files)} {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
      <button type="button" className="group flex items-center gap-3 h-12 px-4 rounded-[7px] border border-border bg-bg-deep hover:border-accent/60 transition text-left cursor-pointer" onClick={() => input.current?.click()}>
        <span className="text-accent font-mono">&gt;_</span>
        <span className="font-mono text-[13px] text-text-2 group-hover:text-text flex-1 truncate">{folder ? folder : "Choose a folder on your computer…"}</span>
        <span className="text-[11.5px] text-dim">browse</span>
      </button>
      {files.length > 0 && (
        <div className="flex items-center gap-3 text-[12.5px] text-muted prose">
          <span>{files.length} files · {fmt(total)}</span><span className="text-dim">dependencies and build folders are left out</span>
        </div>
      )}
      <label className="block"><span className="label">Project name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={folder || "my-app"} /></label>
      {err && <div className="text-[12.5px] text-red-soft prose">{err}</div>}
      <div className="flex items-center gap-3">
        <button className="btn-primary h-9 px-4" disabled={!files.length || !!busy} onClick={() => void upload()}>{busy ? <><Spinner /> {busy}</> : <>Upload and analyse {Icon.chevron({ size: 14 })}</>}</button>
        <span className="text-[11.5px] text-dim prose">Up to 60 MB. The copy lives in your Arkus space; edits here change that copy, not the folder on your computer.</span>
      </div>
    </div>
  );
}
