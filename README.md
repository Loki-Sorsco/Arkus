# Arkus — the control room for your software (V1, local-first)

Arkus reads a project's code and database and draws the whole system as one map:
**Pages → API calls → Endpoints → Tables**. You can browse it, trace every form field to the
request key and the column it lands in, read plain-English writeups of each endpoint, query the
database in English, and propose changes as **Plans** that Arkus turns into precise hand-off guides.
Nothing in your repo or database is modified by Arkus in V1.

Two ways in:

- **Import an existing app** — point Arkus at a local folder (or a git URL) and optionally connect its
  database read-only. The analysis streams live and ends in the workspace.
- **Design a new app** — describe the idea, answer a few questions, get a blueprint (tables · APIs ·
  pages), edit it, export the spec (Prisma / SQL / OpenAPI / tasks) or scaffold a runnable Next.js +
  Prisma repo. The scaffold is then imported like any other project.

## Run it

```bash
npx arkus
```

That is the whole install. Arkus needs Node 22.5 or newer. It starts on this machine only (127.0.0.1), opens
your browser, and keeps its own data in `~/.arkus` (metadata database, encrypted connection strings, cloned
repos). Your source folders are read in place and never copied. `npx arkus --help` lists the few flags.

Everything works without AI: import, map, APIs, database browsing and editing, SQL you write, plans.
AI (free Groq tier) adds Ask in plain English, English → SQL, flow names, writeups and AI blueprints.
Turn it on from **More → Settings → AI** by pasting a Groq key (verified with Groq, stored encrypted).

Private GitHub repositories: on **Import → Git URL** switch on *Private repository* and paste a
fine-grained token with Contents: read (also under **More → Connections → GitHub access**).

### Develop

```bash
npm install                 # also generates the Prisma client
npx prisma db push          # creates prisma/dev.db for development
npm run dev                 # http://localhost:3600
npm run build && npm start  # production build, then the same launcher users get
```

## What is supported today

| Area | Coverage |
|---|---|
| Routes | Next.js App Router + Pages Router + Server Actions, Express, Fastify, Hono, Koa, NestJS, tRPC, FastAPI, Flask, Django, OpenAPI/Swagger files |
| Schema | Prisma, SQL migration folders (incl. Supabase/Prisma migrations), SQLAlchemy, Django models, live introspection of PostgreSQL / MySQL / SQLite |
| Frontend callers | fetch, axios (+ instances), SWR, React Query, RTK Query, tRPC client, server actions; conditional URLs/methods; custom wrappers partially |
| Bindings | form field → request key → column, with confidence; server-filled and frontend-only rows |
| Database | read-only browse with PII masking, guarded SQL (adversarial corpus 100% blocked), EXPLAIN, saved queries, English → SQL (with AI) |
| Plans | add field / add column / edit writeup / data edit → changes by layer, forward + reverse migration, checks with evidence, hand-off guide + "Copy as AI prompt", verify-after-push |
| Architect | idea → questions → blueprint (AI or offline templates) → inline edits / flip assumptions / refine → export → scaffold → import |

Not yet: health monitoring, the Pro "agent applies the change" path, GitHub App / hosted multi-tenant
control plane, RBAC, MCP server package, write queries.

## The workspace: three things

Arkus V1 is three screens, picked from the left rail (Ctrl 1 / 2 / 3):

- **Map**: the whole app as lanes (pages → APIs → tables → services). Click a card to light up what it touches and inspect it
  on the right; double-click to jump to it. **Blast radius** paints everything that depends on the selected card red.
- **APIs**: the list on the left, one endpoint on the right with three tabs. **Explain** (what it does, request and response,
  what it is connected to), **Code** (the handler, editable, Ctrl+S saves), **Test** (send a real request, see the response).
- **Database**: tables on the left (expand for columns), the table on the right with **Data** (edit rows, Apply) and
  **Structure**. **Query** opens the SQL console, which also takes a question in English when AI is on. **Diagram** draws the
  schema; the ⋯ menu holds history, drift, sync and connect.

**Ask** (Ctrl L) opens a chat about the app on the right of any screen. Flows, Plans, Activity, Connections and Settings sit
behind **More** at the bottom of the rail. Ctrl K finds a page, API or table. Old URLs (`/overview`, `/pages`, `/requests`,
`/database?tab=`) redirect to the new screens.

## Editing for real

- **Table tab → Data → Edit**: click a cell to change it (Enter saves, Esc cancels, Tab moves on), **Add row**, trash icon to delete.
  Every write is a single parameterised statement targeted by primary key with an optimistic guard, logged under Activity → Writes,
  with a 6-second Undo for cell edits. Secret columns (password, token, hash, key…) are never shown or written. Prod asks for a
  typed confirmation first.
- **Code**: every endpoint and page tab carries its handler file in a CodeMirror pane; any file opens from the Explorer or the
  inspector's Code section. Ctrl+S saves. Saves are atomic, keep the file's line endings, refuse to overwrite a file that changed on
  disk since you opened it, and are logged under Activity → Code edits. "VS Code" jumps to the same line in your editor.
  Re-index the map after structural changes.

## Design

Near-black terminal look: `#0A0A0B` background, JetBrains Mono for all UI chrome, IBM Plex Sans (`.prose`) for paragraphs,
one green accent `#34D399` used only for primary actions, active states and links. Lanes keep their own colours: pages gold,
APIs blue, tables teal, services purple; blast radius is red. Tokens live in `src/app/globals.css` (plus `glow`, `dots`,
`stat-box`, `type-pill` helpers); shared primitives in `src/components/ui.tsx`.

The Map draws Onboard-style cards: type pill, name, two stats, file. "Auto" density keeps cards compact until they are on the
selected path; "Cards" and "Compact" force one or the other. **Blast radius** paints everything upstream of the selected card
red with an "impacted" badge, and the corner card counts the pages, APIs and tables that would be affected.

## Ask and Flows

- **Ask** (`/p/<slug>/ask`, or type a question into ⌘K): answers come only from the stack graph, the schema and scrubbed source peeks. Every answer cites the pages, APIs, tables or columns it used; the chips open those screens. Without a Groq key it falls back to a search-style summary.
- **Flows** (`/p/<slug>/flows`): the app as the things people can do ("Sign up", "Create a project", "Invite a member"), derived from page → API → table chains. Each flow is a page → API → tables storyline with a Plain / Technical toggle, numbered steps, captured fields and file:line evidence. Titles are named by AI when a key is set (cached), otherwise by heuristics. Flows linked only by matching names are marked low confidence.

## Database management

- Connections are per environment (dev / preview / prod) and managed in **Connections**. Connection strings are encrypted at rest (AES-256-GCM) with a key at `~/.arkus/secret.key` (or `ARKUS_SECRET_KEY`); they are never returned to the browser.
- Each connection can be tested, re-synced (new schema snapshot + diff), edited or removed. Every sync is kept in **Database → History** with a diff against the previous snapshot.
- **Database → Drift** compares the live schema with the schema declared in code (Prisma / SQL); it is informational only.
- Reads only: one SELECT per query, LIMIT ≤ 1000, PII masked, secret columns never selected. Exact row counts on demand; saved queries and history in **Database → Query**.
- API: `/api/projects/<slug>/db/{sources, sources/:id/test, sources/:id/sync, schema/history, schema/diff, drift, count, tables, rows, query, explain, queries}`.

## Layout

```
src/lib/arkus/
  types.ts        graph vocabulary (nodes, edges, bindings, facts)
  fs.ts           repo walker · .gitignore/.arkusignore · secret scrub
  detect.ts       stack detection
  extractors/     per-framework fact extractors (+ fixtures/ and scripts/test-extractors.ts)
  resolve.ts      facts → graph + bindings
  indexer.ts      pipeline with streaming log → snapshot
  graph.ts        persist/load, impact analysis, ⌘K search
  plans.ts        cascade planner, migrations, checks, hand-off guide
  writeups.ts     endpoint writeups + sense-check
  dbconn.ts introspect.ts sqlguard.ts browse.ts nl2sql.ts   read-only DB layer
  architect/      blueprint schema, generation, exports, scaffold
src/app/          Next.js routes: / (start) · /import · /new · /p/[slug]/[[...section]] (map | apis | database | flows | plans | activity | connect | settings)
src/components/shell/     workspace (state + layout, URL = state) · activity-bar (rail) · title-bar · right-panel · status-bar · code-drawer · palette
src/components/sections/  one screen per section: map · apis (+ apis-list, apis-test) · database · misc (flows, plans, activity, connect, settings)
src/components/tabs/      views reused inside sections (table, query, schema, history, drift, flows, plans, …) + writeup-view, request-editor, response-view
src/components/panels/    list panes (flows, plans) · ask-pane
src/app/api/      JSON API (see each route file header)
design/           the Claude Design reference (arkus-shell.dc.html) · DESIGN_TOKENS.css
```

Tests: `npx tsx scripts/test-extractors.ts` · `npx tsx scripts/test-sqlguard.ts` · `npx tsx scripts/test-db.ts` · `npx tsx scripts/test-architect.ts`.
