"use client";
// Key/value grid for params, headers and form bodies: enabled checkbox · name · value · delete, with an
// always-present blank row at the end (typing in it appends a row).
import type { KV } from "@/lib/arkus/http";
import { Icon } from "@/components/ui";
import { cx } from "@/lib/ui";

export const kvRow = (name = "", value = ""): KV => ({ name, value, enabled: true });

export function KVGrid({ rows, onChange, namePlaceholder = "name", valuePlaceholder = "value", secretNames, className }: { rows: KV[]; onChange: (rows: KV[]) => void; namePlaceholder?: string; valuePlaceholder?: string; secretNames?: RegExp; className?: string }) {
  const all = [...rows, kvRow()];
  const set = (i: number, patch: Partial<KV>) => {
    const next = all.map((r, j) => (j === i ? { ...r, ...patch } : r));
    // Drop the trailing blank row unless the edit just filled it.
    const last = next[next.length - 1];
    if (!last.name && !last.value) next.pop();
    onChange(next);
  };
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div className={cx("text-[12px] font-mono", className)}>
      <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1.4fr)_28px] h-6 items-center border-b border-border text-[10.5px] font-semibold uppercase tracking-[.06em] text-dim font-sans">
        <span /><span className="px-2">Name</span><span className="px-2">Value</span><span />
      </div>
      {all.map((r, i) => {
        const blank = i === rows.length;
        const secret = !!secretNames && secretNames.test(r.name);
        return (
          <div key={i} className={cx("grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1.4fr)_28px] items-center border-b border-border/60 group/kv", !r.enabled && !blank && "opacity-50")}>
            <span className="flex items-center justify-center">{!blank && <input type="checkbox" className="accent-[var(--accent)] w-3 h-3 cursor-pointer" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />}</span>
            <input className="h-7 px-2 bg-transparent outline-none text-text placeholder:text-dim min-w-0 border-r border-border/60 focus:bg-surface-2" value={r.name} placeholder={blank ? namePlaceholder : ""} spellCheck={false} onChange={(e) => set(i, { name: e.target.value })} />
            <input className="h-7 px-2 bg-transparent outline-none text-text-2 placeholder:text-dim min-w-0 focus:bg-surface-2" type={secret ? "password" : "text"} value={r.value} placeholder={blank ? valuePlaceholder : ""} spellCheck={false} onChange={(e) => set(i, { value: e.target.value })} />
            <span className="flex items-center justify-center">{!blank && <button className="text-dim hover:text-red-soft opacity-0 group-hover/kv:opacity-100 cursor-pointer" title="Remove" onClick={() => remove(i)}>{Icon.close({ size: 12 })}</button>}</span>
          </div>
        );
      })}
    </div>
  );
}
