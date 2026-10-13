// Builds fixtures/sample.sqlite (users/orders with a FK, a few rows). Run: node scripts/make-fixture.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
const file = path.resolve(process.cwd(), "fixtures/sample.sqlite");
fs.mkdirSync(path.dirname(file), { recursive: true });
if (fs.existsSync(file)) fs.unlinkSync(file);
const db = new DatabaseSync(file);
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    phone TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX orders_user_id_idx ON orders(user_id);
  CREATE INDEX orders_status_created_idx ON orders(status, created_at);
  CREATE VIEW user_totals AS SELECT u.id, u.email, sum(o.total) AS spent FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id;
`);
const u = db.prepare("INSERT INTO users (email, name, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)");
u.run("ada@example.com", "Ada Lovelace", "+15551234567", "$2b$10$abcdefghijklmnopqrstuv", "admin");
u.run("linus@example.com", "Linus T", "+15559876543", "$2b$10$zyxwvutsrqponmlkjihgfe", "member");
u.run("grace@example.com", "Grace Hopper", null, "$2b$10$0123456789abcdefghijkl", "member");
const o = db.prepare("INSERT INTO orders (user_id, total, status) VALUES (?, ?, ?)");
o.run(1, 19.99, "paid"); o.run(1, 250, "paid"); o.run(2, 5.5, "pending"); o.run(3, 99, "refunded"); o.run(3, 12, "paid");
db.close();
console.log("fixture written:", file);
