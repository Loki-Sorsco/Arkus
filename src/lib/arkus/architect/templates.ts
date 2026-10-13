// Five deterministic blueprint templates used when the LLM is unavailable (or returns garbage).
// Each template names its entities from nouns detected in the idea ("tutor", "class", "booking"…).
import type { BlueprintInput } from "./schema";
import { toSnake } from "./schema";

type Col = NonNullable<BlueprintInput["entities"][number]["columns"][number]>;
type Ent = BlueprintInput["entities"][number];
type Ep = NonNullable<BlueprintInput["endpoints"]>[number];
type Pg = NonNullable<BlueprintInput["pages"]>[number];

export const TEMPLATE_NAMES = ["saas", "marketplace", "booking", "ecommerce", "crm"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

const KEYWORDS: Record<TemplateName, string[]> = {
  marketplace: ["marketplace", "tutor", "seller", "vendor", "freelancer", "gig", "listing", "two-sided", "buyers and sellers", "host", "rent"],
  booking: ["booking", "appointment", "schedule", "reservation", "calendar", "slot", "salon", "clinic", "doctor", "barber", "availability"],
  ecommerce: ["ecommerce", "e-commerce", "shop", "store", "cart", "checkout", "product", "inventory", "catalog", "merch"],
  crm: ["crm", "lead", "pipeline", "deal", "contact", "sales", "customer relationship", "follow-up", "prospect"],
  saas: ["saas", "dashboard", "workspace", "team", "subscription", "analytics", "tool", "app", "platform"],
};

export function pickTemplate(idea: string): TemplateName {
  const s = idea.toLowerCase();
  let best: TemplateName = "saas"; let bestScore = 0;
  for (const name of TEMPLATE_NAMES) {
    const score = KEYWORDS[name].reduce((n, k) => n + (s.includes(k) ? (k.length > 5 ? 2 : 1) : 0), 0);
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best;
}

// ---------------- noun detection ----------------

const PROVIDERS = ["tutor", "teacher", "coach", "seller", "vendor", "host", "freelancer", "driver", "doctor", "instructor", "trainer", "therapist", "consultant", "artist", "mentor", "stylist", "barber", "agent", "landlord", "chef"];
const BUYERS = ["student", "learner", "customer", "client", "buyer", "guest", "patient", "rider", "member", "shopper", "tenant", "attendee"];
const ITEMS = ["class", "course", "lesson", "session", "product", "service", "listing", "room", "property", "gig", "job", "event", "ticket", "workout", "recipe", "task", "project", "invoice", "document", "post", "meal", "car", "tour", "plan", "campaign"];
const ORDERS = ["booking", "order", "reservation", "appointment", "purchase", "enrollment", "subscription", "rental", "request"];

export function plural(n: string): string {
  if (/(s|x|z|ch|sh)$/.test(n)) return n + "es";
  if (/[^aeiou]y$/.test(n)) return n.slice(0, -1) + "ies";
  return n + "s";
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const title = (s: string) => s.split("_").map(cap).join(" ");

export interface Nouns { provider: string; buyer: string; item: string; order: string; }

const VERB_STEMS: Record<string, string> = { book: "booking", reserve: "reservation", enroll: "enrollment", enrol: "enrollment", rent: "rental", subscribe: "subscription", buy: "purchase", order: "order" };

export function detectNouns(idea: string, defaults: Nouns): Nouns {
  const stem = (w: string) => /ies$/.test(w) ? w.slice(0, -3) + "y" : /(ses|xes|ches|shes)$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w;
  const words = idea.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/).map(stem).map((w) => VERB_STEMS[w] ?? w);
  const find = (list: string[], d: string) => list.find((n) => words.includes(n)) ?? d;
  return { provider: find(PROVIDERS, defaults.provider), buyer: find(BUYERS, defaults.buyer), item: find(ITEMS, defaults.item), order: find(ORDERS, defaults.order) };
}

export function appNameFromIdea(idea: string, fallback: string): string {
  const m = idea.match(/(?:called|named)\s+["']?([A-Za-z][A-Za-z0-9]{1,30})/);
  return m ? m[1] : fallback;
}

// ---------------- column/endpoint builders ----------------

const c = (name: string, type: Col["type"], extra: Partial<Col> = {}): Col => ({ name, type, nullable: false, ...extra });
const base = (): Col[] => [c("id", "uuid", { pk: true, default: "gen_random_uuid()" }), c("created_at", "timestamptz", { default: "now()" })];
const fk = (name: string, table: string, nullable = false): Col => c(name, "uuid", { nullable, references: { table, column: "id" } });
const ent = (name: string, table: string, description: string, cols: Col[], indexes?: Ent["indexes"]): Ent => ({ name, table, description, columns: [...base(), ...cols], indexes });

const usersEntity = (roles: string[]): Ent => ent("User", "users", "Account holder.", [
  c("email", "text", { unique: true }), c("password_hash", "text"), c("name", "text"),
  c("role", "text", { default: `'${roles[0]}'` }),
], [{ columns: ["email"], unique: true }]);

const authEndpoints = (): Ep[] => [
  { method: "POST", path: "/api/auth/signup", name: "Sign up", description: "Create an account", auth: false,
    request: [{ key: "email", type: "string", required: true, validation: "email" }, { key: "password", type: "string", required: true, validation: "min(8)" }, { key: "name", type: "string", required: true }],
    response: [{ key: "id", type: "string" }, { key: "email", type: "string" }], reads: ["users"], writes: ["users"] },
  { method: "POST", path: "/api/auth/login", name: "Log in", description: "Verify credentials and start a session", auth: false,
    request: [{ key: "email", type: "string", required: true, validation: "email" }, { key: "password", type: "string", required: true }],
    response: [{ key: "token", type: "string" }], reads: ["users"], writes: [] },
];
const authPages = (): Pg[] => [
  { path: "/signup", name: "Sign up", kind: "auth", calls: ["POST /api/auth/signup"], fields: [
    { label: "Name", key: "name", uiType: "text", required: true, endpoint: "POST /api/auth/signup", column: "users.name" },
    { label: "Email", key: "email", uiType: "email", required: true, endpoint: "POST /api/auth/signup", column: "users.email" },
    { label: "Password", key: "password", uiType: "password", required: true, endpoint: "POST /api/auth/signup", column: "users.password_hash" },
  ] },
  { path: "/login", name: "Log in", kind: "auth", calls: ["POST /api/auth/login"], fields: [
    { label: "Email", key: "email", uiType: "email", required: true, endpoint: "POST /api/auth/login", column: "users.email" },
    { label: "Password", key: "password", uiType: "password", required: true, endpoint: "POST /api/auth/login", column: "users.password_hash" },
  ] },
];

/** list + get + create endpoints and list + new pages for an entity with the given form columns. */
function crud(table: string, label: string, formCols: Col[], extraReads: string[] = []): { endpoints: Ep[]; pages: Pg[] } {
  const path = `/api/${table}`;
  const req = formCols.map((col) => ({ key: col.name, type: col.type === "numeric" || col.type === "integer" ? "number" : col.type === "boolean" ? "boolean" : "string", required: !col.nullable }));
  const ui = (col: Col) => col.type === "numeric" || col.type === "integer" ? "number" : col.type === "boolean" ? "checkbox" : col.type === "date" || col.type === "timestamptz" ? "date" : col.references ? "select" : /description|notes|body/.test(col.name) ? "textarea" : "text";
  return {
    endpoints: [
      { method: "GET", path, name: `List ${plural(label)}`, description: `Paginated list of ${plural(label)}`, auth: true, request: [{ key: "page", type: "number", required: false }], response: [{ key: "items", type: "array" }], reads: [table, ...extraReads], writes: [] },
      { method: "GET", path: `${path}/:id`, name: `Get ${label}`, description: `One ${label} by id`, auth: true, request: [], response: [{ key: "id", type: "string" }], reads: [table], writes: [] },
      { method: "POST", path, name: `Create ${label}`, description: `Create a ${label}`, auth: true, request: req, response: [{ key: "id", type: "string" }], reads: extraReads, writes: [table] },
    ],
    pages: [
      { path: `/${table}`, name: plural(title(label)), kind: "list", calls: [`GET ${path}`], fields: [] },
      { path: `/${table}/new`, name: `New ${title(label)}`, kind: "form", calls: [`POST ${path}`], fields: formCols.map((col) => ({ label: title(col.name.replace(/_id$/, "")), key: col.name, uiType: ui(col), required: !col.nullable, endpoint: `POST ${path}`, column: `${table}.${col.name}` })) },
      { path: `/${table}/:id`, name: title(label), kind: "display", calls: [`GET ${path}/:id`], fields: [] },
    ],
  };
}

const stack = (payments?: string): BlueprintInput["stack"] => ({
  frontend: "Next.js 16 (App Router, React 19, Tailwind v4)", backend: "Next.js route handlers + zod", database: "SQLite (dev) / PostgreSQL (prod) via Prisma",
  auth: "Email + password sessions (httpOnly cookie)", payments, hosting: "Vercel or any Node host",
  reasons: ["One TypeScript codebase for UI and API keeps the team small", "Prisma gives a typed schema that Arkus can index and migrate", "SQLite needs zero setup locally; swap the provider for Postgres in production"],
});

// ---------------- templates ----------------

export function templateBlueprint(idea: string, name?: TemplateName): BlueprintInput {
  const t = name ?? pickTemplate(idea);
  return BUILDERS[t](idea);
}

const BUILDERS: Record<TemplateName, (idea: string) => BlueprintInput> = {
  marketplace(idea) {
    const n = detectNouns(idea, { provider: "seller", buyer: "buyer", item: "listing", order: "order" });
    const items = plural(n.item), orders = plural(n.order);
    const listing = crud(items, n.item, [c("title", "text"), c("description", "text", { nullable: true }), c("price", "numeric"), fk(`${n.provider}_id`, "users")]);
    const order = crud(orders, n.order, [fk(`${n.item}_id`, items), c("starts_at", "timestamptz"), c("notes", "text", { nullable: true })], [items]);
    return {
      name: appNameFromIdea(idea, `${cap(n.item)} Marketplace`), summary: `A two-sided marketplace where ${plural(n.provider)} publish ${items} and ${plural(n.buyer)} ${n.order === "booking" ? "book" : "order"} and pay for them.`,
      stack: stack("Stripe Checkout + webhooks"),
      entities: [
        usersEntity([n.buyer, n.provider]),
        ent(cap(n.item), items, `Something a ${n.provider} offers.`, [c("title", "text"), c("description", "text", { nullable: true }), c("price", "numeric"), c("currency", "text", { default: "'USD'" }), fk(`${n.provider}_id`, "users"), c("status", "text", { default: "'draft'" })], [{ columns: [`${n.provider}_id`] }, { columns: ["status"] }]),
        ent(cap(n.order), orders, `A ${n.buyer}'s ${n.order} of a ${n.item}.`, [fk(`${n.item}_id`, items), fk(`${n.buyer}_id`, "users"), c("starts_at", "timestamptz"), c("status", "text", { default: "'pending'" }), c("notes", "text", { nullable: true })], [{ columns: [`${n.item}_id`] }, { columns: [`${n.buyer}_id`] }]),
        ent("Payment", "payments", "Stripe payment for an order.", [fk(`${n.order}_id`, orders), c("amount", "numeric"), c("currency", "text", { default: "'USD'" }), c("provider_ref", "text", { nullable: true }), c("status", "text", { default: "'requires_payment'" })], [{ columns: [`${n.order}_id`], unique: true }]),
        ent("Review", "reviews", `A ${n.buyer}'s rating of a completed ${n.order}.`, [fk(`${n.order}_id`, orders), c("rating", "integer"), c("body", "text", { nullable: true })], [{ columns: [`${n.order}_id`], unique: true }]),
      ],
      endpoints: [...authEndpoints(), ...listing.endpoints, ...order.endpoints,
        { method: "POST", path: `/api/${orders}/:id/pay`, name: `Pay for ${n.order}`, description: "Create a Stripe Checkout session for the order", auth: true, request: [], response: [{ key: "checkout_url", type: "string" }], reads: [orders], writes: ["payments"] },
        { method: "POST", path: "/api/webhooks/stripe", name: "Stripe webhook", description: "Marks payments paid; verified by Stripe signature", auth: false, internal: true, request: [{ key: "id", type: "string", required: true }, { key: "type", type: "string", required: true }], response: [{ key: "received", type: "boolean" }], reads: ["payments"], writes: ["payments", orders] },
        { method: "POST", path: "/api/reviews", name: "Create review", description: "Rate a completed order", auth: true, request: [{ key: `${n.order}_id`, type: "string", required: true }, { key: "rating", type: "number", required: true, validation: "1..5" }, { key: "body", type: "string", required: false }], response: [{ key: "id", type: "string" }], reads: [orders], writes: ["reviews"] },
      ],
      pages: [...authPages(), ...listing.pages, ...order.pages,
        { path: `/${orders}/:id/pay`, name: "Checkout", kind: "form", calls: [`POST /api/${orders}/:id/pay`], fields: [] },
        { path: `/${orders}/:id/review`, name: "Leave a review", kind: "form", calls: ["POST /api/reviews"], fields: [
          { label: "Rating", key: "rating", uiType: "number", required: true, endpoint: "POST /api/reviews", column: "reviews.rating" },
          { label: "Review", key: "body", uiType: "textarea", required: false, endpoint: "POST /api/reviews", column: "reviews.body" },
        ] },
      ],
      services: [{ name: "stripe", purpose: "Checkout sessions and payment webhooks" }, { name: "email", purpose: `Confirmation emails to ${plural(n.buyer)} and ${plural(n.provider)}` }],
      jobs: [{ name: "expire_unpaid", schedule: "every 15 minutes", purpose: `Cancel ${orders} unpaid after 30 minutes` }],
      assumptions: [
        { id: "roles", text: `One users table with a role column (${n.buyer} | ${n.provider})`, alternative: `Separate ${plural(n.buyer)} and ${plural(n.provider)} tables`, chosen: true },
        { id: "payments", text: "Stripe Checkout (hosted page) rather than custom card forms", alternative: "Stripe Elements embedded in the app", chosen: true },
        { id: "pricing", text: `Each ${n.item} has a single fixed price`, alternative: "Tiered or hourly pricing", chosen: true },
      ],
      checks: [],
    };
  },

  booking(idea) {
    const n = detectNouns(idea, { provider: "staff", buyer: "customer", item: "service", order: "appointment" });
    const items = plural(n.item), orders = plural(n.order);
    const svc = crud(items, n.item, [c("name", "text"), c("duration_minutes", "integer"), c("price", "numeric")]);
    const appt = crud(orders, n.order, [fk(`${n.item}_id`, items), fk("slot_id", "availability_slots"), c("notes", "text", { nullable: true })], [items, "availability_slots"]);
    appt.pages[2].calls = [...(appt.pages[2].calls ?? []), `DELETE /api/${orders}/:id`];
    return {
      name: appNameFromIdea(idea, `${cap(n.order)} Scheduler`), summary: `${cap(plural(n.buyer))} pick a ${n.item} and an open time slot; ${plural(n.provider)} manage availability.`,
      stack: stack(),
      entities: [
        usersEntity([n.buyer, n.provider, "admin"]),
        ent(cap(n.item), items, "Bookable service.", [c("name", "text"), c("duration_minutes", "integer"), c("price", "numeric"), c("active", "boolean", { default: "true" })]),
        ent("AvailabilitySlot", "availability_slots", `A time window a ${n.provider} can be booked.`, [fk(`${n.provider}_id`, "users"), c("starts_at", "timestamptz"), c("ends_at", "timestamptz"), c("booked", "boolean", { default: "false" })], [{ columns: [`${n.provider}_id`, "starts_at"] }]),
        ent(cap(n.order), orders, `A confirmed ${n.order}.`, [fk(`${n.buyer}_id`, "users"), fk(`${n.item}_id`, items), fk("slot_id", "availability_slots"), c("status", "text", { default: "'confirmed'" }), c("notes", "text", { nullable: true })], [{ columns: ["slot_id"], unique: true }, { columns: [`${n.buyer}_id`] }, { columns: [`${n.item}_id`] }]),
      ],
      endpoints: [...authEndpoints(), ...svc.endpoints, ...appt.endpoints,
        { method: "GET", path: "/api/availability_slots", name: "List open slots", description: "Open slots for a service in a date range", auth: false, request: [{ key: "from", type: "string", required: true }, { key: "to", type: "string", required: true }], response: [{ key: "items", type: "array" }], reads: ["availability_slots"], writes: [] },
        { method: "POST", path: "/api/availability_slots", name: "Add slot", description: `${cap(n.provider)} opens a slot`, auth: true, request: [{ key: "starts_at", type: "string", required: true }, { key: "ends_at", type: "string", required: true }], response: [{ key: "id", type: "string" }], reads: [], writes: ["availability_slots"] },
        { method: "DELETE", path: `/api/${orders}/:id`, name: `Cancel ${n.order}`, description: "Cancel and free the slot", auth: true, request: [], response: [{ key: "ok", type: "boolean" }], reads: [orders], writes: [orders, "availability_slots"] },
      ],
      pages: [...authPages(), ...svc.pages, ...appt.pages,
        { path: "/availability", name: "Availability", kind: "form", calls: ["GET /api/availability_slots", "POST /api/availability_slots"], fields: [
          { label: "Starts at", key: "starts_at", uiType: "date", required: true, endpoint: "POST /api/availability_slots", column: "availability_slots.starts_at" },
          { label: "Ends at", key: "ends_at", uiType: "date", required: true, endpoint: "POST /api/availability_slots", column: "availability_slots.ends_at" },
        ] },
      ],
      services: [{ name: "email", purpose: "Confirmation and reminder emails" }, { name: "calendar", purpose: "Optional Google Calendar sync" }],
      jobs: [{ name: "send_reminders", schedule: "hourly", purpose: `Email reminders 24h before each ${n.order}` }],
      assumptions: [
        { id: "roles", text: `Single users table with role (${n.buyer} | ${n.provider} | admin)`, alternative: `Separate ${plural(n.provider)} table`, chosen: true },
        { id: "slots", text: "Availability is explicit slots (not recurring rules)", alternative: "Recurring weekly rules expanded on read", chosen: true },
        { id: "payments", text: "No online payment; pay on site", alternative: "Stripe prepayment at booking", chosen: true },
      ],
      checks: [],
    };
  },

  ecommerce(idea) {
    const n = detectNouns(idea, { provider: "admin", buyer: "customer", item: "product", order: "order" });
    const items = plural(n.item);
    const prod = crud(items, n.item, [c("name", "text"), c("description", "text", { nullable: true }), c("price", "numeric"), c("stock", "integer")]);
    return {
      name: appNameFromIdea(idea, `${cap(n.item)} Store`), summary: `${cap(plural(n.buyer))} browse ${items}, add them to a cart and check out with Stripe.`,
      stack: stack("Stripe Checkout"),
      entities: [
        usersEntity([n.buyer, "admin"]),
        ent(cap(n.item), items, "Sellable item.", [c("name", "text"), c("description", "text", { nullable: true }), c("price", "numeric"), c("stock", "integer", { default: "0" }), c("image_url", "text", { nullable: true })], [{ columns: ["name"] }]),
        ent("Cart", "carts", "Open cart per user.", [fk("user_id", "users"), c("status", "text", { default: "'open'" })], [{ columns: ["user_id"] }]),
        ent("CartItem", "cart_items", "Line in a cart.", [fk("cart_id", "carts"), fk(`${n.item}_id`, items), c("quantity", "integer", { default: "1" })], [{ columns: ["cart_id", `${n.item}_id`], unique: true }, { columns: [`${n.item}_id`] }]),
        ent("Order", "orders", "Placed order.", [fk("user_id", "users"), c("total", "numeric"), c("status", "text", { default: "'pending'" }), c("shipping_address", "jsonb", { nullable: true })], [{ columns: ["user_id"] }]),
        ent("OrderItem", "order_items", "Snapshot of a cart line at checkout.", [fk("order_id", "orders"), fk(`${n.item}_id`, items), c("quantity", "integer"), c("unit_price", "numeric")], [{ columns: ["order_id"] }, { columns: [`${n.item}_id`] }]),
        ent("Payment", "payments", "Stripe payment.", [fk("order_id", "orders"), c("amount", "numeric"), c("provider_ref", "text", { nullable: true }), c("status", "text", { default: "'pending'" })], [{ columns: ["order_id"], unique: true }]),
      ],
      endpoints: [...authEndpoints(), ...prod.endpoints,
        { method: "POST", path: "/api/cart_items", name: "Add to cart", description: "Add a product to the current cart", auth: true, request: [{ key: `${n.item}_id`, type: "string", required: true }, { key: "quantity", type: "number", required: true, validation: "min(1)" }], response: [{ key: "id", type: "string" }], reads: ["carts", items], writes: ["carts", "cart_items"] },
        { method: "GET", path: "/api/cart", name: "Get cart", description: "Current cart with lines", auth: true, request: [], response: [{ key: "items", type: "array" }, { key: "total", type: "number" }], reads: ["carts", "cart_items", items], writes: [] },
        { method: "POST", path: "/api/orders", name: "Checkout", description: "Turn the cart into an order and a Stripe session", auth: true, request: [{ key: "shipping_address", type: "object", required: true }], response: [{ key: "checkout_url", type: "string" }], reads: ["carts", "cart_items", items], writes: ["orders", "order_items", "payments", "carts"] },
        { method: "GET", path: "/api/orders", name: "List orders", description: "My orders", auth: true, request: [], response: [{ key: "items", type: "array" }], reads: ["orders"], writes: [] },
        { method: "POST", path: "/api/webhooks/stripe", name: "Stripe webhook", description: "Marks payments paid; verified by signature", auth: false, internal: true, request: [{ key: "id", type: "string", required: true }, { key: "type", type: "string", required: true }], response: [{ key: "received", type: "boolean" }], reads: ["payments"], writes: ["payments", "orders", items] },
      ],
      pages: [...authPages(), ...prod.pages,
        { path: "/cart", name: "Cart", kind: "form", calls: ["GET /api/cart", "POST /api/cart_items"], fields: [
          { label: cap(n.item), key: `${n.item}_id`, uiType: "hidden", required: true, endpoint: "POST /api/cart_items", column: `cart_items.${n.item}_id` },
          { label: "Quantity", key: "quantity", uiType: "number", required: true, endpoint: "POST /api/cart_items", column: "cart_items.quantity" },
        ] },
        { path: "/checkout", name: "Checkout", kind: "form", calls: ["POST /api/orders"], fields: [
          { label: "Shipping address", key: "shipping_address", uiType: "textarea", required: true, endpoint: "POST /api/orders", column: "orders.shipping_address" },
        ] },
        { path: "/orders", name: "My orders", kind: "list", calls: ["GET /api/orders"], fields: [] },
      ],
      services: [{ name: "stripe", purpose: "Checkout and webhooks" }, { name: "email", purpose: "Order confirmations" }, { name: "s3", purpose: "Product images" }],
      jobs: [{ name: "release_stock", schedule: "every 30 minutes", purpose: "Return stock from orders unpaid after 1h" }],
      assumptions: [
        { id: "roles", text: "Single users table with role (customer | admin)", alternative: "Separate admins table", chosen: true },
        { id: "variants", text: `${cap(items)} have no variants (size/colour)`, alternative: "Add a variants table under each product", chosen: true },
        { id: "payments", text: "Stripe Checkout hosted page", alternative: "Stripe Elements embedded", chosen: true },
      ],
      checks: [],
    };
  },

  crm(idea) {
    const n = detectNouns(idea, { provider: "rep", buyer: "contact", item: "deal", order: "task" });
    const contacts = crud("contacts", "contact", [c("name", "text"), c("email", "text", { nullable: true }), c("phone", "text", { nullable: true }), fk("company_id", "companies", true)], ["companies"]);
    const deals = crud(plural(n.item), n.item, [c("title", "text"), c("value", "numeric"), c("stage", "text"), fk("contact_id", "contacts")], ["contacts"]);
    return {
      name: appNameFromIdea(idea, "Pipeline CRM"), summary: `Track companies, contacts and ${plural(n.item)} through a pipeline; log notes and ${plural(n.order)}.`,
      stack: stack(),
      entities: [
        usersEntity(["rep", "manager"]),
        ent("Company", "companies", "Account / organisation.", [c("name", "text"), c("domain", "text", { nullable: true })], [{ columns: ["name"] }]),
        ent("Contact", "contacts", "Person at a company.", [c("name", "text"), c("email", "text", { nullable: true }), c("phone", "text", { nullable: true }), fk("company_id", "companies", true), fk("owner_id", "users", true)], [{ columns: ["company_id"] }, { columns: ["owner_id"] }, { columns: ["email"] }]),
        ent(cap(n.item), plural(n.item), "Opportunity moving through stages.", [c("title", "text"), c("value", "numeric"), c("stage", "text", { default: "'new'" }), fk("contact_id", "contacts"), fk("owner_id", "users", true), c("closes_at", "date", { nullable: true })], [{ columns: ["stage"] }, { columns: ["contact_id"] }, { columns: ["owner_id"] }]),
        ent("Note", "notes", "Timeline entry on a deal.", [fk(`${n.item}_id`, plural(n.item)), fk("author_id", "users"), c("body", "text")], [{ columns: [`${n.item}_id`] }, { columns: ["author_id"] }]),
        ent(cap(n.order), plural(n.order), "Follow-up to do.", [fk(`${n.item}_id`, plural(n.item), true), fk("assignee_id", "users"), c("title", "text"), c("due_at", "timestamptz", { nullable: true }), c("done", "boolean", { default: "false" })], [{ columns: ["assignee_id", "done"] }, { columns: [`${n.item}_id`] }]),
      ],
      endpoints: [...authEndpoints(), ...contacts.endpoints, ...deals.endpoints,
        { method: "PATCH", path: `/api/${plural(n.item)}/:id`, name: `Move ${n.item}`, description: "Change stage or value", auth: true, request: [{ key: "stage", type: "string", required: false }, { key: "value", type: "number", required: false }], response: [{ key: "id", type: "string" }], reads: [plural(n.item)], writes: [plural(n.item)] },
        { method: "POST", path: "/api/notes", name: "Add note", description: "Log activity on a deal", auth: true, request: [{ key: `${n.item}_id`, type: "string", required: true }, { key: "body", type: "string", required: true }], response: [{ key: "id", type: "string" }], reads: [plural(n.item)], writes: ["notes"] },
        { method: "POST", path: "/api/companies", name: "Create company", description: "Add an account", auth: true, request: [{ key: "name", type: "string", required: true }, { key: "domain", type: "string", required: false }], response: [{ key: "id", type: "string" }], reads: [], writes: ["companies"] },
        { method: "POST", path: `/api/${plural(n.order)}`, name: `Create ${n.order}`, description: "Assign a follow-up", auth: true, request: [{ key: "title", type: "string", required: true }, { key: "assignee_id", type: "string", required: true }, { key: `${n.item}_id`, type: "string", required: false }, { key: "due_at", type: "string", required: false }], response: [{ key: "id", type: "string" }], reads: ["users"], writes: [plural(n.order)] },
      ],
      pages: [...authPages(), ...contacts.pages, ...deals.pages,
        { path: "/pipeline", name: "Pipeline board", kind: "list", calls: [`GET /api/${plural(n.item)}`, `PATCH /api/${plural(n.item)}/:id`], fields: [] },
        { path: `/${plural(n.item)}/:id/notes`, name: "Add note", kind: "form", calls: ["POST /api/notes"], fields: [{ label: "Note", key: "body", uiType: "textarea", required: true, endpoint: "POST /api/notes", column: "notes.body" }] },
        { path: "/companies/new", name: "New company", kind: "form", calls: ["POST /api/companies"], fields: [
          { label: "Name", key: "name", uiType: "text", required: true, endpoint: "POST /api/companies", column: "companies.name" },
          { label: "Domain", key: "domain", uiType: "text", required: false, endpoint: "POST /api/companies", column: "companies.domain" },
        ] },
        { path: `/${plural(n.order)}/new`, name: `New ${n.order}`, kind: "form", calls: [`POST /api/${plural(n.order)}`], fields: [
          { label: "Title", key: "title", uiType: "text", required: true, endpoint: `POST /api/${plural(n.order)}`, column: `${plural(n.order)}.title` },
          { label: "Assignee", key: "assignee_id", uiType: "select", required: true, endpoint: `POST /api/${plural(n.order)}`, column: `${plural(n.order)}.assignee_id` },
          { label: "Due", key: "due_at", uiType: "date", required: false, endpoint: `POST /api/${plural(n.order)}`, column: `${plural(n.order)}.due_at` },
        ] },
      ],
      services: [{ name: "email", purpose: "Task reminders and digests" }],
      jobs: [{ name: "daily_digest", schedule: "daily 08:00", purpose: "Email each rep their due tasks" }],
      assumptions: [
        { id: "roles", text: "Single users table with role (rep | manager)", alternative: "Teams table with memberships", chosen: true },
        { id: "stages", text: "Pipeline stages are a fixed text enum", alternative: "A stages table editable by managers", chosen: true },
      ],
      checks: [],
    };
  },

  saas(idea) {
    const n = detectNouns(idea, { provider: "owner", buyer: "member", item: "project", order: "subscription" });
    const items = plural(n.item);
    const proj = crud(items, n.item, [c("name", "text"), c("description", "text", { nullable: true }), fk("workspace_id", "workspaces")], ["workspaces"]);
    return {
      name: appNameFromIdea(idea, `${cap(n.item)} Hub`), summary: `Teams sign up, create a workspace, invite members and manage ${items}; billed per workspace.`,
      stack: stack("Stripe Billing (subscriptions)"),
      entities: [
        usersEntity([n.buyer, n.provider]),
        ent("Workspace", "workspaces", "Tenant / team.", [c("name", "text"), c("slug", "text", { unique: true }), fk("owner_id", "users"), c("plan", "text", { default: "'free'" })], [{ columns: ["slug"], unique: true }, { columns: ["owner_id"] }]),
        ent("Membership", "memberships", "User ↔ workspace with a role.", [fk("workspace_id", "workspaces"), fk("user_id", "users"), c("role", "text", { default: `'${n.buyer}'` })], [{ columns: ["workspace_id", "user_id"], unique: true }, { columns: ["user_id"] }]),
        ent("Invitation", "invitations", "Pending invite by email.", [fk("workspace_id", "workspaces"), c("email", "text"), c("token", "text", { unique: true }), c("accepted_at", "timestamptz", { nullable: true })], [{ columns: ["workspace_id"] }]),
        ent(cap(n.item), items, `Core object of the product.`, [fk("workspace_id", "workspaces"), c("name", "text"), c("description", "text", { nullable: true }), c("status", "text", { default: "'active'" }), c("settings", "jsonb", { nullable: true })], [{ columns: ["workspace_id"] }]),
        ent(cap(n.order), plural(n.order), "Stripe subscription per workspace.", [fk("workspace_id", "workspaces"), c("provider_ref", "text", { nullable: true }), c("status", "text", { default: "'trialing'" }), c("current_period_end", "timestamptz", { nullable: true })], [{ columns: ["workspace_id"], unique: true }]),
      ],
      endpoints: [...authEndpoints(), ...proj.endpoints,
        { method: "POST", path: "/api/workspaces", name: "Create workspace", description: "Create a tenant and make the caller its owner", auth: true, request: [{ key: "name", type: "string", required: true }, { key: "slug", type: "string", required: true, validation: "slug" }], response: [{ key: "id", type: "string" }], reads: ["users"], writes: ["workspaces", "memberships"] },
        { method: "POST", path: "/api/invitations", name: "Invite member", description: "Email an invite link", auth: true, request: [{ key: "workspace_id", type: "string", required: true }, { key: "email", type: "string", required: true, validation: "email" }], response: [{ key: "id", type: "string" }], reads: ["memberships"], writes: ["invitations"] },
        { method: "POST", path: "/api/invitations/:token/accept", name: "Accept invite", description: "Join the workspace", auth: true, request: [], response: [{ key: "workspace_id", type: "string" }], reads: ["invitations"], writes: ["memberships", "invitations"] },
        { method: "POST", path: "/api/billing/checkout", name: "Start subscription", description: "Stripe Billing checkout session", auth: true, request: [{ key: "workspace_id", type: "string", required: true }, { key: "plan", type: "string", required: true }], response: [{ key: "checkout_url", type: "string" }], reads: ["workspaces"], writes: [plural(n.order)] },
        { method: "POST", path: "/api/webhooks/stripe", name: "Stripe webhook", description: "Subscription lifecycle events", auth: false, internal: true, request: [{ key: "id", type: "string", required: true }, { key: "type", type: "string", required: true }], response: [{ key: "received", type: "boolean" }], reads: [plural(n.order)], writes: [plural(n.order), "workspaces"] },
      ],
      pages: [...authPages(), ...proj.pages,
        { path: "/dashboard", name: "Dashboard", kind: "display", calls: [`GET /api/${items}`], fields: [] },
        { path: "/workspaces/new", name: "New workspace", kind: "form", calls: ["POST /api/workspaces"], fields: [
          { label: "Name", key: "name", uiType: "text", required: true, endpoint: "POST /api/workspaces", column: "workspaces.name" },
          { label: "Slug", key: "slug", uiType: "text", required: true, endpoint: "POST /api/workspaces", column: "workspaces.slug" },
        ] },
        { path: "/settings/members", name: "Members", kind: "form", calls: ["POST /api/invitations"], fields: [
          { label: "Workspace", key: "workspace_id", uiType: "hidden", required: true, endpoint: "POST /api/invitations", column: "invitations.workspace_id" },
          { label: "Email", key: "email", uiType: "email", required: true, endpoint: "POST /api/invitations", column: "invitations.email" },
        ] },
        { path: "/settings/billing", name: "Billing", kind: "form", calls: ["POST /api/billing/checkout"], fields: [
          { label: "Workspace", key: "workspace_id", uiType: "hidden", required: true, endpoint: "POST /api/billing/checkout", column: "workspaces.id" },
          { label: "Plan", key: "plan", uiType: "select", required: true, endpoint: "POST /api/billing/checkout", column: "workspaces.plan" },
        ] },
        { path: "/invite/:token", name: "Accept invite", kind: "form", calls: ["POST /api/invitations/:token/accept"], fields: [] },
      ],
      services: [{ name: "stripe", purpose: "Subscriptions" }, { name: "email", purpose: "Invites and billing emails" }],
      jobs: [{ name: "expire_invites", schedule: "daily", purpose: "Delete invitations older than 7 days" }],
      assumptions: [
        { id: "roles", text: `Multiple roles per workspace via memberships.role (${n.provider} | ${n.buyer})`, alternative: "Single role: every member is equal", chosen: true },
        { id: "tenancy", text: "Multi-tenant: one database, workspace_id on every row", alternative: "Single-tenant per customer", chosen: true },
        { id: "payments", text: "Stripe Billing subscriptions per workspace", alternative: "No billing in v1", chosen: true },
      ],
      checks: [],
    };
  },
};

export const templateLabel = (t: TemplateName) => ({ saas: "SaaS (teams + workspaces)", marketplace: "Two-sided marketplace", booking: "Booking / scheduling", ecommerce: "E-commerce store", crm: "CRM / pipeline" })[t];
export const snakeName = toSnake;
