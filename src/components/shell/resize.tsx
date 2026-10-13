"use client";
// Drag-to-resize for panels. `useResizable` keeps the size in localStorage; `ResizeHandle` is the
// 5px hit area you drag (rendered on the edge of the panel it resizes).
import { useCallback, useRef } from "react";
import { cx, useLocal } from "@/lib/ui";

export function useResizable(key: string, initial: number, opts: { min: number; max: number; axis: "x" | "y"; invert?: boolean }) {
  const [size, setSize] = useLocal<number>(`arkus:ui:size:${key}`, initial);
  const start = useRef<{ at: number; size: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { at: opts.axis === "x" ? e.clientX : e.clientY, size };
    document.body.style.cursor = opts.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [opts.axis, size]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const now = opts.axis === "x" ? e.clientX : e.clientY;
    const d = (now - start.current.at) * (opts.invert ? -1 : 1);
    setSize(Math.max(opts.min, Math.min(opts.max, start.current.size + d)));
  }, [opts.axis, opts.invert, opts.min, opts.max, setSize]);
  const onPointerUp = useCallback(() => { start.current = null; document.body.style.cursor = ""; document.body.style.userSelect = ""; }, []);
  return { size, setSize, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

export function ResizeHandle({ axis, className, ...rest }: { axis: "x" | "y"; className?: string } & Record<string, unknown>) {
  return <div {...rest} className={cx("absolute z-20 hover:bg-accent/60 active:bg-accent transition-colors", axis === "x" ? "top-0 bottom-0 w-[5px] -mx-[2px] cursor-col-resize" : "left-0 right-0 h-[5px] -my-[2px] cursor-row-resize", className)} />;
}
