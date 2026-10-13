// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const order = await prisma.order.findUnique({ where: { id: Number(params.id) } });
  return NextResponse.json(order);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  await prisma.order.delete({ where: { id: Number(params.id) } });
  return NextResponse.json({ ok: true });
}
