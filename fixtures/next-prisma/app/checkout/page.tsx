// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
"use client";
import { useState } from "react";
import { OrderSummary } from "@/components/OrderSummary";

export default function CheckoutPage() {
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState(0);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/checkout", { method: "POST", body: JSON.stringify({ email, amount }) });
    await res.json();
  }
  return (
    <form onSubmit={submit}>
      <label htmlFor="email">Email address</label>
      <input id="email" name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <label>
        Card number
        <input name="card" placeholder="4242 4242 4242 4242" />
      </label>
      <input name="amount" type="number" placeholder="Amount" onChange={(e) => setAmount(Number(e.target.value))} />
      <select name="currency"><option>USD</option></select>
      <OrderSummary id={1} />
      <button type="submit">Pay</button>
    </form>
  );
}
