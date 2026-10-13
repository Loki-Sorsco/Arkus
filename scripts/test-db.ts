// End-to-end check of the sqlite path: test → open → introspect → browse → guard → query → explain → nl2sql offline.
// Run: node scripts/make-fixture.mjs && npx tsx scripts/test-db.ts
import fs from "node:fs";
import path from "node:path";
import { testConnection, openConnection, parseDbUrl, redact } from "../src/lib/arkus/dbconn";
import { introspect } from "../src/lib/arkus/introspect";
import { browseRows, maskRow } from "../src/lib/arkus/browse";
import { guardRead } from "../src/lib/arkus/sqlguard";
import { nlToSql, starterQueries } from "../src/lib/arkus/nl2sql";

let pass = 0, fail = 0;
const check = (name: string, cond: unknown, detail?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, detail !== undefined ? JSON.stringify(detail) : ""); }
};

(async () => {
  const root = process.cwd();
  const file = path.join(root, "fixtures", "sample.sqlite");
  check("fixture exists", fs.existsSync(file), file);

  const p = parseDbUrl("postgres://app:S3cret!@db.internal:5433/shop");
  check("parseDbUrl redacts password", p.display === "postgres://app@db.internal:5433/shop" && p.hasPassword, p);
  check("redact strips password from error", !redact("auth failed for postgres://app:S3cret!@db.internal:5433/shop", "postgres://app:S3cret!@db.internal:5433/shop").includes("S3cret"));
  check("parseDbUrl sqlite file:", parseDbUrl("file:./fixtures/sample.sqlite").engine === "sqlite");

  const cfg = { url: "file:./fixtures/sample.sqlite" };
  const t = await testConnection(cfg, root);
  check("testConnection ok", t.ok && t.stages.map(s => s.name).join(">") === "File>Open>Introspect" && t.tableCount === 2 && t.local === true, t);
  const bad = await testConnection({ url: "file:./fixtures/missing.sqlite" }, root);
  check("testConnection missing file fails at File stage", !bad.ok && bad.stages[0].name === "File" && !bad.stages[0].ok, bad);

  const conn = await openConnection(cfg, root);
  check("driver engine", conn.engine === "sqlite");
  try {
    await conn.query("INSERT INTO users (email, password_hash) VALUES ('x@y.z', 'h')");
    check("read-only enforced", false);
  } catch (e) { check("read-only enforced (insert rejected by sqlite readOnly)", /readonly|read-only|attempt to write/i.test((e as Error).message), (e as Error).message); }

  const intro = await introspect(conn);
  const users = intro.tables.find(x => x.name === "users")!;
  const orders = intro.tables.find(x => x.name === "orders")!;
  check("introspect tables", intro.tables.map(x => x.name).join(",") === "orders,users" && intro.stats.viewsSkipped === 1, intro.stats);
  check("engineVersion", /^\d+\.\d+/.test(intro.engineVersion), intro.engineVersion);
  check("users columns", users.columns.length === 7 && users.columns[0].name === "id" && users.columns[0].pk === true);
  check("users.email unique + not null", users.columns.find(c => c.name === "email")?.unique === true && users.columns.find(c => c.name === "email")?.nullable === false);
  check("users.role default", users.columns.find(c => c.name === "role")?.default === "'member'", users.columns.find(c => c.name === "role"));
  check("orders.user_id FK", JSON.stringify(orders.columns.find(c => c.name === "user_id")?.references) === JSON.stringify({ table: "users", column: "id" }));
  check("orders indexes", (orders.indexes ?? []).some(i => i.name === "orders_status_created_idx" && i.columns.join(",") === "status,created_at"), orders.indexes);
  check("rowEstimate", users.rowEstimate === 3 && orders.rowEstimate === 5, [users.rowEstimate, orders.rowEstimate]);
  check("source introspection", users.source === "introspection");

  const b1 = await browseRows(conn, intro.tables, "users", { page: 1, pageSize: 2 });
  check("browse page 1", b1.rows.length === 2 && b1.pageSize === 2 && b1.hidden.includes("password_hash") && !("password_hash" in b1.rows[0]), b1);
  check("browse masks email + phone", b1.rows[0].email === "a***@example.com" && String(b1.rows[0].phone).startsWith("••••"), b1.rows[0]);
  const b2 = await browseRows(conn, intro.tables, "users", { page: 2, pageSize: 2 });
  check("browse page 2 + exact total", b2.rows.length === 1 && b2.total === 3 && b2.totalExact, b2);
  const b3 = await browseRows(conn, intro.tables, "orders", { filters: [{ column: "status", op: "=", value: "paid" }, { column: "total", op: ">", value: "10" }], sort: { column: "total", dir: "desc" } });
  check("browse filters + sort", b3.rows.length === 3 && b3.rows[0].total === 250 && b3.total === 3 && b3.totalExact, b3.rows);
  const b4 = await browseRows(conn, intro.tables, "orders", { filters: [{ column: "status", op: "like", value: "p%" }] });
  check("browse like", b4.rows.length === 4, b4.rows.length);
  const b5 = await browseRows(conn, intro.tables, "users", { filters: [{ column: "phone", op: "is null" }] });
  check("browse is null", b5.rows.length === 1 && b5.rows[0].name === "Grace Hopper");
  await browseRows(conn, intro.tables, "nope", {}).then(() => check("browse unknown table rejected", false)).catch(e => check("browse unknown table rejected", /unknown table/.test(e.message)));
  await browseRows(conn, intro.tables, "users", { sort: { column: "id; DROP" } }).then(() => check("browse unknown column rejected", false)).catch(e => check("browse unknown column rejected", /unknown column/.test(e.message)));
  await browseRows(conn, intro.tables, "users", { filters: [{ column: "password_hash", op: "=", value: "x" }] }).then(() => check("browse filter on secret rejected", false)).catch(e => check("browse filter on secret rejected", /secret/.test(e.message)));
  check("maskRow", JSON.stringify(maskRow({ email: "bob@x.io", token: "t", ssn: "123456789", name: "Bob" })) === JSON.stringify({ email: "b***@x.io", ssn: "••••89", name: "Bob" }));

  const allowed = intro.tables.map(x => x.name);
  const g = guardRead("SELECT u.email, count(o.id) AS n FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.email", allowed, { engine: "sqlite" });
  check("guard accepts join + appends limit", g.ok && /LIMIT 1000$/.test(g.sql), g);
  if (g.ok) {
    const r = await conn.query(g.sql);
    check("guarded query executes", r.rows.length === 3 && r.fields.join(",") === "email,n", r);
  }
  const bad1 = guardRead("SELECT * FROM users; DROP TABLE users", allowed, { engine: "sqlite" });
  const bad2 = guardRead("SELECT * FROM user_totals", allowed, { engine: "sqlite" });
  const bad3 = guardRead("SELECT * FROM sqlite_master", allowed, { engine: "sqlite" });
  check("guard blocks stacked / view-not-in-allowlist / sqlite_master", !bad1.ok && !bad2.ok && !bad3.ok, [bad1, bad2, bad3]);

  const ex = await conn.query("EXPLAIN QUERY PLAN " + (g.ok ? g.sql : "SELECT 1"));
  check("explain query plan", ex.rows.length > 0 && typeof ex.rows[0].detail === "string", ex.rows);

  const st = starterQueries(intro.tables, "sqlite");
  check("starter queries", st.length === 3 && st[0].sql.startsWith("SELECT count(*)") && st.every(s => guardRead(s.sql, allowed, { engine: "sqlite" }).ok), st);
  for (const s of st) { const gg = guardRead(s.sql, allowed, { engine: "sqlite" }); if (gg.ok) { const r = await conn.query(gg.sql); check(`starter runs: ${s.name}`, r.rows.length > 0, r); } }
  delete process.env.GROQ_API_KEY;
  const nl = await nlToSql({ question: "how many paid orders per user?", tables: intro.tables, engine: "sqlite" });
  check("nl2sql offline fallback", !nl.ok && nl.reason === "AI not configured" && nl.starters.length === 3, nl);

  await conn.close();
  console.log(`\ntest-db: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("test-db crashed:", e); process.exit(1); });
