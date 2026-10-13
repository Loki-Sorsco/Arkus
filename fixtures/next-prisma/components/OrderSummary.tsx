// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
import useSWR from "swr";
export function OrderSummary({ id }: { id: number }) {
  const { data } = useSWR(`/api/orders/${id}`);
  return <div>{data?.amount}</div>;
}
