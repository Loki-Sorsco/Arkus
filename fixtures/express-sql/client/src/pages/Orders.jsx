// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
import { useEffect, useState } from "react";
import axios from "axios";
import api from "../lib/api";

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState(0);
  useEffect(() => { api.get("/orders").then((r) => setOrders(r.data)); }, []);
  async function create() {
    await axios.post("/api/orders", { email, amount });
    const one = await api.get(`/orders/${orders[0]?.id}`);
    console.log(one.data);
  }
  return (
    <div>
      <input name="email" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input name="amount" type="number" value={amount} onChange={(e) => setAmount(+e.target.value)} />
      <button onClick={create}>Create</button>
      <ul>{orders.map((o) => <li key={o.id}>{o.amount}</li>)}</ul>
    </div>
  );
}
