// Local folder picker. Lists sub-directories of a path (defaults to the user's home / Downloads).
import os from "node:os";
import path from "node:path";
import { listDirs } from "@/lib/arkus/fs";
import { bad, ok } from "../_util";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const home = os.homedir();
  const dir = u.searchParams.get("dir") || path.join(home, "Downloads");
  try {
    const dirs = await listDirs(dir);
    const parent = path.dirname(dir);
    return ok({ dir, parent: parent === dir ? null : parent, home, dirs });
  } catch { return bad("Can't read that folder"); }
}
