// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const { email, amount } = await req.json();
  const user = await prisma.user.findUnique({ where: { email } });
  const order = await prisma.order.create({ data: { amount, userId: user?.id ?? 0 } });
  await stripe.paymentIntents.create({ amount, currency: "usd" });
  return NextResponse.json({ id: order.id });
}
