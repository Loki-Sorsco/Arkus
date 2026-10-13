"use client";
// /p/<slug>/<section> renders that section's screen. Old URLs are translated once:
//   overview → map · pages?sel= → map?sel= · requests → apis?view=test · files?path= → map + code drawer
//   database?tab=schema|query|history|drift → database?view= · ask?q= → Ask panel
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { useWorkspace } from "@/components/shell/workspace";
import { MapSection } from "@/components/sections/map";
import { ApisSection } from "@/components/sections/apis";
import { DatabaseSection } from "@/components/sections/database";
import { FlowsSection, PlansSection, SimpleSection } from "@/components/sections/misc";

export default function SectionRoute() {
  const { section, project, openFile, openAsk } = useWorkspace();
  const sp = useSearchParams();
  const router = useRouter();
  const raw = typeof window !== "undefined" ? window.location.pathname.split("/")[3] || "map" : "map";
  const translated = useRef<string | null>(null);
  useEffect(() => {
    const key = window.location.pathname + window.location.search;
    if (translated.current === key) return;
    translated.current = key;
    const base = `/p/${project.slug}`;
    const sel = sp.get("sel");
    switch (raw) {
      case "overview": router.replace(`${base}/map${sel ? `?sel=${encodeURIComponent(sel)}` : ""}`); break;
      case "pages": router.replace(`${base}/map${sel ? `?sel=${encodeURIComponent(sel)}` : ""}`); break;
      case "requests": router.replace(`${base}/apis?view=test`); break;
      case "files": { const p = sp.get("path"); router.replace(`${base}/map`); if (p) openFile(p, Number(sp.get("line")) || undefined); break; }
      case "ask": router.replace(`${base}/map`); openAsk(sp.get("q") || undefined); break;
      case "database": { const tab = sp.get("tab"); if (tab) { const view = tab === "schema" ? "diagram" : tab === "data" ? "table" : tab; router.replace(`${base}/database?view=${view}${sel ? `&sel=${encodeURIComponent(sel)}` : ""}`); } break; }
    }
  }, [raw, sp, router, project.slug, openFile, openAsk]);

  switch (section) {
    case "apis": return <ApisSection />;
    case "database": return <DatabaseSection />;
    case "flows": return <FlowsSection />;
    case "plans": return <PlansSection />;
    case "activity": case "connect": case "settings": return <SimpleSection kind={section} />;
    default: return <MapSection />;
  }
}
