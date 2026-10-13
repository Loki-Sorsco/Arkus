// POST → Server-Sent Events stream of index log lines, ending with a "done" or "error" event.
import { indexProject } from "@/lib/arkus/indexer";
import { bad } from "../../../_util";
import { resolveProject } from "@/lib/arkus/project";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await resolveProject(id);
  if (!p) return bad("Not found", 404);
  if (!p.rootPath) return bad("This project has no local folder yet");
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const r = await indexProject(p.id, (l) => send("log", l));
        send("done", { snapshotId: r.snapshotId, stats: r.stats, det: r.det, unresolved: r.graph.unresolved });
      } catch (e) {
        send("error", { message: (e as Error).message });
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
