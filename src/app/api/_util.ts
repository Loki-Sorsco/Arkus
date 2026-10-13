import { NextResponse } from "next/server";
export const ok = (data: unknown, init?: ResponseInit) => NextResponse.json(data, init);
export const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "project";
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> { try { return (await req.json()) as T; } catch { return {} as T; } }
