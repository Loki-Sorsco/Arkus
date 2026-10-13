// GET → { configured, login } · POST { token } → verify + store encrypted · DELETE → forget.
import { bad, ok, readJson } from "../../_util";
import { clearGithubToken, githubTokenInfo, setGithubToken } from "@/lib/arkus/gitclone";

export async function GET() { return ok(await githubTokenInfo()); }

export async function POST(req: Request) {
  const body = await readJson<{ token?: string }>(req);
  if (!body.token?.trim()) return bad("Paste a GitHub token");
  try { const r = await setGithubToken(body.token); return ok({ configured: true, login: r.login }); }
  catch (e) { return bad((e as Error).message); }
}

export async function DELETE() { await clearGithubToken(); return ok({ configured: false }); }
