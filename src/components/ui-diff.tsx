"use client";
// Small line diff (LCS on lines, capped) and its +/- rendering, shared by the Change tab and anything else
// that previews an overwrite. Unchanged runs collapse to a "… n lines" row so a long file stays readable.
import { useMemo } from "react";
import { cx } from "@/lib/ui";

export type DiffLine = { t: " " | "+" | "-"; s: string };

export function lineDiff(a: string, b: string): DiffLine[] | null {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  // Trim the common prefix / suffix so the quadratic part only covers the changed window.
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const X = A.slice(s, A.length - e), Y = B.slice(s, B.length - e);
  if (X.length * Y.length > 2_000_000) return null;
  const dp: Uint16Array[] = Array.from({ length: X.length + 1 }, () => new Uint16Array(Y.length + 1));
  for (let i = X.length - 1; i >= 0; i--) for (let j = Y.length - 1; j >= 0; j--) dp[i][j] = X[i] === Y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = A.slice(0, s).map((l) => ({ t: " ", s: l }));
  let i = 0, j = 0;
  while (i < X.length && j < Y.length) { if (X[i] === Y[j]) { out.push({ t: " ", s: X[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: X[i++] }); else out.push({ t: "+", s: Y[j++] }); }
  while (i < X.length) out.push({ t: "-", s: X[i++] });
  while (j < Y.length) out.push({ t: "+", s: Y[j++] });
  for (const l of A.slice(A.length - e)) out.push({ t: " ", s: l });
  return out;
}

type Row = DiffLine | { t: "…"; n: number };
/** Keep `ctx` unchanged lines around each change; fold the rest. */
function fold(lines: DiffLine[], ctx: number): Row[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (l.t !== " ") for (let k = i - ctx; k <= i + ctx; k++) keep.add(k); });
  const rows: Row[] = [];
  let hidden = 0;
  lines.forEach((l, i) => { if (keep.has(i)) { if (hidden) rows.push({ t: "…", n: hidden }); hidden = 0; rows.push(l); } else hidden++; });
  if (hidden) rows.push({ t: "…", n: hidden });
  return rows;
}

export function DiffView({ before, after, maxHeight = 360, context = 3, className }: { before: string; after: string; maxHeight?: number; context?: number; className?: string }) {
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const rows = useMemo(() => (diff ? fold(diff, context) : []), [diff, context]);
  if (!diff) return <div className="text-[12px] text-dim prose">The file is too large to diff here; open it in the Code tab after applying.</div>;
  const added = diff.filter((l) => l.t === "+").length, removed = diff.filter((l) => l.t === "-").length;
  return (
    <div className={cx("overflow-auto bg-bg-deep border border-border rounded-[6px] font-mono text-[11.5px] leading-[1.5]", className)} style={{ maxHeight }}>
      <div className="px-2 py-1 text-dim border-b border-border sticky top-0 bg-bg-deep">{added + removed === 0 ? "No changes" : <><span className="text-green">+{added}</span> <span className="text-red-soft">−{removed}</span> <span>· unchanged lines dimmed</span></>}</div>
      {rows.map((r, i) => r.t === "…"
        ? <div key={i} className="px-2 text-dim bg-surface-2/60 select-none">… {r.n} unchanged line{r.n === 1 ? "" : "s"}</div>
        : <div key={i} className={cx("px-2 whitespace-pre", r.t === "+" ? "bg-green/10 text-green" : r.t === "-" ? "bg-red/10 text-red-soft" : "text-dim")}>{r.t} {r.s}</div>)}
    </div>
  );
}
