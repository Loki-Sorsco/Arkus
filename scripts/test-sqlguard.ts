// Adversarial corpus for src/lib/arkus/sqlguard.ts. Run: npx tsx scripts/test-sqlguard.ts
import { guardRead, classifyWrite } from "../src/lib/arkus/sqlguard";

const ALLOWED = ["users", "orders", "order_items", "products", "public.audit_log", "Payments"];

const MALICIOUS: string[] = [
  "SELECT 1; DROP TABLE users",
  "SELECT * FROM users; DELETE FROM users",
  "DROP TABLE users",
  "DELETE FROM users WHERE id = 1",
  "UPDATE users SET name = 'x'",
  "INSERT INTO users (name) VALUES ('x')",
  "TRUNCATE users",
  "ALTER TABLE users ADD COLUMN x int",
  "CREATE TABLE evil (x int)",
  "GRANT ALL ON users TO public",
  "COPY users TO '/tmp/users.csv'",
  "CALL do_something()",
  "EXEC xp_cmdshell 'dir'",
  "SELECT * FROM users INTO OUTFILE '/tmp/x'",
  "SELECT * FROM users INTO DUMPFILE '/tmp/x'",
  "SELECT pg_sleep(10)",
  "SELECT PG_SLEEP(10) FROM users",
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT lo_import('/etc/passwd')",
  "SELECT load_file('/etc/passwd')",
  "SELECT * FROM dblink('dbname=x', 'select 1') AS t(a int)",
  "SELECT sleep(10)",
  "SELECT benchmark(1000000, md5('x'))",
  "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x",
  "WITH x AS (UPDATE users SET name='a' RETURNING id) SELECT * FROM x",
  "WITH x AS (INSERT INTO users(name) VALUES('a') RETURNING id) SELECT * FROM x",
  "SELECT * FROM information_schema.tables",
  "SELECT * FROM pg_catalog.pg_tables",
  "SELECT * FROM sqlite_master",
  "SELECT * FROM mysql.user",
  "SELECT * FROM secrets",                                      // not in allow-list
  "SELECT * FROM users u JOIN secrets s ON s.user_id = u.id",
  "SELECT * FROM users WHERE id IN (SELECT id FROM secrets)",
  "SELECT * FROM users /* comment */ WHERE 1=1",
  "SELECT * FROM users -- comment\nWHERE 1=1",
  "SELECT * FROM users # comment",
  "SEL/**/ECT * FROM users",
  "SELECT/**/1;/**/DROP/**/TABLE/**/users",
  "SELECT * FROM users FOR UPDATE",
  "SELECT * FROM users FOR SHARE",
  "SELECT * FROM users\u0000; DROP TABLE users",
  "ＳＥＬＥＣＴ * FROM users; DROP TABLE users",                  // fullwidth letters (NFKC -> ASCII; still stacked)
  "SELECT * FROM users WHERE name = 'a' UNION SELECT * FROM secrets",
  "SELECT * FROM users UNION ALL SELECT * FROM pg_shadow",
  "sElEcT * fRoM uSeRs; dRoP tAbLe users",
  "SELECT * FROM users WHERE 1=1; SELECT pg_sleep(5)",
  "SELECT 'a\\'; DROP TABLE users; --' FROM users",            // backslash-escape confusion
  "SELECT $$x$$; DROP TABLE users",
  "SELECT * FROM users LIMIT 10; DROP TABLE users",
  "SET SESSION sql_mode = ''",
  "SHOW TABLES",
  "PRAGMA writable_schema = 1",
  "ATTACH DATABASE '/tmp/x.db' AS x",
  "SELECT * FROM users RETURNING *",
  "SELECT current_user, session_user",
  "SELECT version()",
  "SELECT set_config('x', 'y', false)",
  "SELECT nextval('users_id_seq')",
  "SELECT * FROM pg_sleep(1) AS t",
  "SELECT writefile('/tmp/x', 'y')",
  "SELECT load_extension('evil.so')",
  "SELECT * FROM 'users'; DELETE FROM orders",
  "SELECT * FROM users FETCH FIRST 5000 ROWS ONLY",
  "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t, secrets",
  "SELECT * FROM users WHERE id = 1 OR 1=1; -- ",
  "SELECT (SELECT string_agg(usename, ',') FROM pg_user)",
  "SELECT * FROM users LIMIT 10 OFFSET 0; TRUNCATE orders",
  "DO $$ BEGIN DELETE FROM users; END $$",
  "SELECT * FROM users​; DROP TABLE users",                 // zero-width space
];

const VALID: string[] = [
  "SELECT * FROM users",
  "select id, email from users where created_at > '2024-01-01' order by id desc",
  "SELECT u.id, count(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id",
  "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days') SELECT user_id, sum(total) FROM recent GROUP BY user_id",
  "SELECT * FROM users LIMIT 999999",                           // capped to 1000
  "SELECT * FROM users LIMIT 10 OFFSET 20",
  "SELECT * FROM public.audit_log WHERE action = 'login' LIMIT 5;",
  "SELECT * FROM \"Payments\" WHERE amount > 100",
  "SELECT * FROM `payments` WHERE status = 'deleted'",          // keyword inside a string literal is fine
  "SELECT count(*) FROM order_items oi JOIN products p ON p.id = oi.product_id",
  "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 50)",
  "SELECT id FROM users UNION SELECT user_id FROM orders",
  "SELECT 1",
  "SELECT replace(name, 'a', 'b') AS n, upper(email) FROM users",
  "SELECT * FROM users WHERE note LIKE '%update%'",
  "SELECT * FROM users LIMIT 1000",
  "SELECT * FROM users;;",                                     // trailing semicolons are stripped
  "(SELECT id FROM users) UNION (SELECT id FROM orders)",
];

let pass = 0, fail = 0;
const failures: string[] = [];
for (const q of MALICIOUS) {
  const r = guardRead(q, ALLOWED, { engine: "postgres" });
  if (r.ok) { fail++; failures.push(`SHOULD BLOCK: ${JSON.stringify(q)} -> ${r.sql}`); } else pass++;
}
for (const q of VALID) {
  const r = guardRead(q, ALLOWED, { engine: "postgres" });
  if (!r.ok) { fail++; failures.push(`SHOULD PASS: ${JSON.stringify(q)} -> ${r.reason}`); }
  else {
    const lim = /\blimit\s+(\d+)(?:\s*,\s*(\d+))?(?:\s+offset\s+\d+)?\s*$/i.exec(r.sql);
    const fetch = /\bfetch\s+(?:first|next)\s+(\d+)/i.exec(r.sql);
    const n = lim ? Number(lim[2] ?? lim[1]) : fetch ? Number(fetch[1]) : NaN;
    if (!(n <= 1000)) { fail++; failures.push(`LIMIT NOT ENFORCED: ${q} -> ${r.sql}`); } else pass++;
  }
}
// Same corpus against mysql + sqlite dialects: every malicious one must still be blocked.
for (const engine of ["mysql", "sqlite"] as const) {
  for (const q of MALICIOUS) {
    const r = guardRead(q, ALLOWED, { engine });
    if (r.ok) { fail++; failures.push(`SHOULD BLOCK (${engine}): ${JSON.stringify(q)} -> ${r.sql}`); } else pass++;
  }
}

const cw = [
  [classifyWrite("DELETE FROM users"), "delete", false],
  [classifyWrite("UPDATE users SET a=1 WHERE id=2"), "update", true],
  [classifyWrite("INSERT INTO users (a) VALUES (1)"), "insert", false],
  [classifyWrite("ALTER TABLE users ADD x int"), "ddl", false],
  [classifyWrite("SELECT 1"), "other", false],
] as const;
for (const [c, kind, hasWhere] of cw) {
  if (c.kind === kind && c.hasWhere === hasWhere) pass++; else { fail++; failures.push(`classifyWrite mismatch: ${JSON.stringify(c)} expected ${kind}/${hasWhere}`); }
}

console.log(`sqlguard corpus: ${MALICIOUS.length} malicious x3 dialects, ${VALID.length} valid, ${cw.length} classify → pass=${pass} fail=${fail}`);
for (const f of failures) console.log("  " + f);
process.exit(fail ? 1 : 0);
