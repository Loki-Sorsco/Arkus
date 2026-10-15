// POST { role: "developer" | "viewer" } → switch the working mode of the current user (local or cloud).
import { asRole, currentUser, setRole } from "@/lib/auth";
import { bad, ok, readJson } from "../../_util";

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return bad("Sign in required", 401);
  const body = await readJson<{ role?: string }>(req);
  const role = asRole(body.role);
  await setRole(me.id, role);
  return ok({ ok: true, role });
}
