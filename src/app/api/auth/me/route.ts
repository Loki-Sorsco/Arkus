// GET → { cloud, user } — the browser asks once to decide what to show (login, local-folder import…).
import { ok } from "../../_util";
import { currentUser, googleConfigured, isCloud } from "@/lib/auth";

export async function GET() { return ok({ cloud: isCloud(), google: googleConfigured(), user: await currentUser() }); }
