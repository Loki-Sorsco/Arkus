# Arkus — Design Notes (PARTIAL — design files NOT read)

> **Provenance warning.** The Claude Design project (`5daf5e56-0a29-45dc-a15a-d998f0c929e3`,
> files `Arkus Shell.dc.html`, `Auth v2.dc.html`, `03 Idea` … `14 Settings`) could **not** be read
> in the session that produced this file: the `DesignSync` tool was not available to the agent.
> Everything below is distilled from two secondary sources only:
>
> 1. `Arkus_Plan_of_Action_v2.pdf` (Downloads), section 2A "Your Arkus UI, screen by screen", which
>    quotes UI copy from the design, and sections 8/9/11 which quote the Plans/Settings screens.
> 2. The project memory note (`arkus-martian-project.md`) written by an earlier session that did
>    read the design: warm dark palette, accent `#E07A4F`, IBM Plex, demo app "tutorly",
>    Plan #4 "add users.full_name".
>
> Strings in quotes are copied verbatim from those sources (and the plan says it copied them from
> the design). Anything marked `[UNVERIFIED]` or `TODO(design)` must be filled in from the actual
> `.dc.html` files before it is treated as spec. **No design token values, pixel dimensions, or
> icon descriptions below are from the design** — none were available.
>
> To finish this document: fetch the eight `.dc.html` files with DesignSync `get_file`
> (projectId above) into `/mnt/c/Users/dell/Downloads/arkus/design/`, then extract
> `:root { --* }` variables, the `.topbar/.rail/.inspector/.editbar` CSS, and every text node.

---

## 1. Design tokens

### 1.1 Confirmed (from memory note of a prior session that read the design)
| Token | Value | Note |
|---|---|---|
| Accent | `#E07A4F` | warm orange; used for primary buttons, ✦ AI affordances, active rail item |
| Font family | IBM Plex (Sans for UI, Mono for code/SQL/paths) | exact `font-family` stack `TODO(design)` |
| Palette | "warm dark" — dark warm-grey/brown surfaces, light warm text | hex values `TODO(design)` |

### 1.2 Not extracted — `TODO(design)`
- `:root` custom properties (bg layers, border, text primary/secondary/muted, success/warn/danger,
  env colours for Dev/Preview/Prod).
- Font sizes / line heights / weights.
- Radii, spacing scale, shadows, striped-banner pattern.
- `DESIGN_TOKENS.css` next to this file contains only the confirmed accent and font family.

---

## 2. Layout (shell) — structure confirmed by plan §2A; dimensions `TODO(design)`

Component tree of the workspace (`Arkus Shell`):

```
AppShell
├─ TopBar                      height TODO(design)
│  ├─ ProjectName              ("tutorly" in demo)
│  ├─ StackLabel               (e.g. Next.js · Supabase; one label per repo in multi-repo)
│  ├─ EnvSwitch                segmented: "Dev" | "Preview" | "Prod"
│  │   └─ ProdBanner           striped banner shown across the top while env = Prod
│  ├─ SpecChip                 spec status chip; gets a ✓ after a successful ship
│  ├─ PlanChip                 current/open plan (e.g. "Plan #4")
│  └─ CommandK                 "⌘K" search trigger
├─ SectionRail                 vertical; width TODO(design)
│  (order) Pages · APIs · Database · Plans · Activity · Connect · Settings
│  (icons) TODO(design)
├─ LeftRail / list panel       per-section list (page list, endpoint list, table tabs)
├─ Canvas                      main content
├─ Inspector (right)           tabs: "Plan" | "Inspect"
└─ EditBar (bottom)            appears when there are unsaved edits
   buttons: "Discard" · "Save to plan"
```

Notes:
- Two journeys land in the same shell: **Build** (Idea → Blueprint → Infrastructure → Build →
  Workspace) and **Import** (repo + database; the plan says the Import/analysis-stream screen
  is "not designed yet").
- Every edit anywhere (Pages ＋ Add field, Database add column / data edit, API writeup edit,
  Suggestions, the AI, MCP) goes to the bottom edit bar as an unsaved change; "Save to plan"
  bundles them into a draft plan.
- ⌘K searches "tables, columns, endpoints, pages, fields, plans".

---

## 3. Screens

### 3.1 Auth (`Auth v2.dc.html`)
States: **login · signup · forgot · sent · validation errors**.
Field labels, button labels, error copy: `TODO(design)`.

### 3.2 Idea → Blueprint (`03 Idea`)
```
IdeaScreen
├─ Prompt heading   "What are you building?"
├─ Textarea         (placeholder TODO(design))
├─ StackChips       "Next.js" · "Supabase" · "Auth" · "Stripe"
├─ Examples         (list of example ideas; one quoted in plan §13:
│                    "A marketplace where tutors list classes and students book and pay.")
└─ Blueprint (streams in)
   ├─ columns: tables · APIs · pages
   ├─ hover-to-link   (hovering a page highlights the APIs it calls and the tables they touch)
   ├─ Assumptions     list; "click one to flip it" (toggling re-runs generation)
   └─ "✦ refine"      (AI refine; produces a diff of the blueprint)
```

### 3.3 Infrastructure (`04`, not in the requested list but in the shell)
DB engine cards: "PostgreSQL / Supabase" (badge "RECOMMENDED"), "PostgreSQL / Neon",
"MongoDB Atlas", "MySQL / PlanetScale", "SQLite / Turso" — each card has "why", good-for and
watch-outs. "Use your own" connection string (validated). Runtimes: "Vercel Functions"
(RECOMMENDED), "Railway", "Cloudflare Workers".

### 3.4 Build (`05`)
Stages, in order: "Create GitHub repo" → "Create the database" → "Generate the APIs" →
"Generate the pages" → "Link fields to keys and columns" (status line
"23 bindings recorded in the stack graph") → "Deploy". Repo shown as `arkus-apps/tutorly`.
Ends as Plan #1 "Initial build".

### 3.5 Pages (`07 Pages`)
```
PagesScreen
├─ PageList         each page tagged form / display
├─ TraceTable       columns: "Field" · "input" → "Key" → "Column"
│   ├─ server-filled rows, e.g. "generated by the database", "computed: tutor rate × length"
│   └─ sense-check errors, e.g. "already exists — link to it?"
├─ "＋ Add field"   type picker: Text · Email · Phone · Number · Date · Yes/no ·
│                   "Frontend only" · "Computed"
└─ LivePreview      live page preview
```
Validation rules the design implies: snake_case key, collision check, "confirm"-type fields
stay frontend-only. One new field → PAGE + API + DB changes in one plan.

### 3.6 APIs (`08 APIs`)
```
ApisScreen
├─ EndpointList     columns: method · path · tables
├─ Tabs             Overview · (Request/Response) · "Try it" · Health [Health "not built" in design]
│  ├─ Overview      "What it does, in order" — numbered steps
│  ├─ Request body / Response tables
│  │     columns: "Key" · "Type" · "validation" · "From page field" · "Stored in"
│  └─ Try it        runner; shows 422 validation errors; on Prod requires type-to-confirm
└─ Inspector        "who can call" · reads/writes · "runs on" · env
```
Demo follow-up string: "GET /me also returns full_name".

### 3.7 Database (`09 Database`) — three tabs
**Data**: table tabs, sort, filter (operators `like` `=` `≠` `>` `<`), FK hover/jump, inline edit,
pending edits → "Preview changes", paging.
**Schema**: ERD with pan/zoom; glyphs PK `●`, FK `◆`, index `▤`; click a column → "Used by"
(pages/APIs via bindings); add column → goes to plan.
**Query**: NL ✦ → SQL; "Read-only" lock; EXPLAIN; export CSV/JSON; saved queries; history.
ERD pan/zoom specifics (wheel vs. drag, zoom bounds): `TODO(design)`.

### 3.8 Safe mutation preview (modal, `10`)
Shows "Rows affected", Before → After per row, "Exact statement · parameterized", helper text:
"Arkus checks each row still has the value you saw before writing. The old values go to Activity,
so this can be reverted." Buttons: "Save to plan" / "Run now" / prod gate.

### 3.9 Plans (`11 Plans`)
```
PlansScreen
├─ Filters          "All" · "Mine" · "Needs review" · "Shipped"
├─ PlanList         (demo: Plan #1 "Initial build", Plan #4 "add users.full_name")
└─ PlanDetail
   ├─ Pipeline      ✎ draft → ◌ previewing → ✓ checks passing → ✓ approved → ✓ shipped (· ✕ failed)
   │     sublabels: "changes by layer, issues" · "preview + DB branch" ·
   │     "evidence for each check" · "Reviewer, bound to hash" · "merge → migrate → deploy"
   ├─ "Changes by layer"   badges PAGE / API / DB
   ├─ "Also suggested"     e.g. "GET /me also returns full_name"
   ├─ Issue (existing rows) "1,284 existing rows in users have no full_name"
   │     options: nullable in DB + required in form (recommended) / fill a default / NOT NULL everywhere
   ├─ "Migration"          expand → contract · "reverse generated"
   ├─ "Checks" with evidence (see list below)
   ├─ "Preview" URL        "Preview builds it against a masked copy of production data."
   ├─ "Ship"               Branch `arkus/plan-N` · PR · CI · checkbox
   │     "I understand this runs the migration on production" · typed project name
   ├─ Comments
   └─ Timeline
```
Checks (name → evidence string):
- "Every form field has an API key" → "3 fields on /signup → 3 keys"
- "Every API key has a column" → "no dangling keys across 5 endpoints"
- "Existing data is compatible" → "1,284 existing rows in users have no full_name"
- "Contract: API stores column" → `POST {"full_name": "Alex Rivera"} → 201 + SELECT ... → 'Alex Rivera'`
- "Contract: GET returns key" → response snippet
- "Access rules cover every table" → "row-level security on 4/4 tables"
- "Reverse migration runs on preview" → "applied, rolled back, re-applied · 0 errors"

### 3.10 Activity (`12`)
Table columns: "When" · "Who" · "Env" · "Kind" · "What" · "Rows".
Filters: "All" · "Data edits" · "Plans" · "Queries" · "Prod only".
Row action "Revert" → opens the safe mutation preview.

### 3.11 Connections (`13 Connections`)
Cards: Repo / Database / Hosting / Payments. Live test steps: "DNS → TCP → Auth → Introspect".
"Use your own Postgres instead · Test & switch" (copies the schema and checks every binding).
Environments table columns: "Environment" · "Branch" · "Database" · "URL" · "Writes".

### 3.12 Settings (`14`)
- Members + roles: "Owner" · "Editor" · "Reviewer" · "Viewer".
- Rule text: "A Reviewer must approve every plan that ships to production"
- "Permissions by environment" matrix: Dev · Preview · Prod.
- MCP server block, copy: "Let Claude Code or Cursor read Tutorly's spec: every entity, field,
  endpoint and binding. They get read access only; changes still go through plans."
  Config snippet: `npx -y @arkus/mcp --project tutorly`, env `ARKUS_API_KEY`. Button "New API key".
- "Danger zone": "Export spec JSON" · "Disconnect".

### 3.13 ⌘K
Search over tables, columns, endpoints, pages, fields, plans. Result row layout `TODO(design)`.

---

## 4. Demo data vocabulary (seed)
- Project: **tutorly** (tutor marketplace: tutors list classes, students book and pay); repo
  `arkus-apps/tutorly`; stack Next.js · Supabase · Auth · Stripe.
- Tables (implied): `users` (needs `full_name`), tutors/classes/bookings/payments
  (`[UNVERIFIED]` names) — "row-level security on 4/4 tables" implies 4 tables.
- Pages: `/signup` (3 fields), computed field "tutor rate × length".
- Endpoints: `GET /me`, signup POST; "5 endpoints".
- Plans: #1 "Initial build" (shipped); #4 "add users.full_name" (demo plan; 1,284 existing rows
  issue; branch `arkus/plan-4`).
- Sample person: "Alex Rivera".
- Bindings count: "23 bindings recorded in the stack graph".
- Roles: Owner / Editor / Reviewer / Viewer; envs Dev / Preview / Prod.

---

## 5. Behaviours worth replicating (from plan; details `TODO(design)`)
- Env switch to Prod → striped banner + prod gates (type-to-confirm on Try it, typed project
  name on Ship, "Run now" gated).
- Blueprint streams in section by section; assumption chips toggle and regenerate; ✦ refine diffs.
- Hover-linking between pages → APIs → tables (blueprint and, per plan §2B, a future Overview map).
- Any edit → bottom edit bar → "Save to plan"; "Discard" clears.
- Query tab is read-only by default (lock); unlocking is role-gated and every write goes through
  the safe mutation preview.
- Data edits are revertable from Activity (revert = new safe mutation).
- Keyboard: ⌘K opens search. Other shortcuts `TODO(design)`.
