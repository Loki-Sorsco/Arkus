// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
"use server";
import { prisma } from "@/lib/prisma";

export async function createOrder(formData: FormData) {
  const email = formData.get("email") as string;
  await prisma.order.create({ data: { amount: 1, userId: 1 } });
  return { ok: true, email };
}
