"use client";
// A query tab (one per console; key = "q..."): owns its SQL text, seeded from tab.params.sql or
// "SELECT * FROM <first table> LIMIT 50". The text is mirrored back into tab.params.sql (debounced) so it
// survives the tab being unmounted or the page reloaded, and the tab label follows the statement.
import { useEffect, useRef, useState } from "react";
import { TabToolbar, useWorkspace } from "@/components/shell/workspace";
import type { Tab } from "@/components/shell/tabs";
import { Chip } from "@/components/ui";
import { QueryTab as QueryConsole } from "@/components/screens/db-query";
import { engineLabel, quoteId, useDbSchema } from "@/components/screens/db-shared";
import { CenteredSpinner, ConnectEmpty } from "./db-common";

/** Tab label: the first 24 characters of the statement, else "Query". */
export const labelForSql = (sql: string) => { const s = sql.replace(/\s+/g, " ").trim(); return s ? s.slice(0, 24) + (s.length > 24 ? "…" : "") : "Query"; };

export function QueryTab({ tab }: { tab: Tab }) {
  const { env, updateTab } = useWorkspace();
  const { tables, engine, source, schemaOnly, loading, reload } = useDbSchema();
  const given = tab.params?.sql;
  const [sql, setSqlRaw] = useState(given ?? "");
  const written = useRef<string | undefined>(given);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A new params.sql from outside (palette, inspector "query this table") replaces the editor text;
  // the value we mirrored ourselves does not.
  useEffect(() => { if (given !== undefined && given !== written.current) { written.current = given; setSqlRaw(given); } }, [given]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const setSql = (s: string) => {
    setSqlRaw(s);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { written.current = s; updateTab(tab.id, { label: labelForSql(s), params: { ...(tab.params || {}), sql: s } }); }, 400);
  };
  // No seed and nothing typed yet: start from the first table once the schema is known.
  useEffect(() => { if (!given && !sql && tables[0]) setSqlRaw(`SELECT * FROM ${quoteId(engine, tables[0].name)} LIMIT 50`); }, [given, sql, tables, engine]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TabToolbar title="Query" meta={<>{env}{engine ? ` · ${engineLabel(engine)}` : ""}</>}
        right={source?.schemaOnly ? <Chip tone="amber">schema only</Chip> : source ? <Chip>read-only</Chip> : null} />
      {loading && !source ? <CenteredSpinner />
        : !source ? <ConnectEmpty title={`No database connected on ${env}`} hint="Queries run against a live connection. Reads only; every statement goes through the read guard." onConnected={reload} />
        : <QueryConsole sql={sql} setSql={setSql} tables={tables} engine={engine} schemaOnly={schemaOnly} />}
    </div>
  );
}
