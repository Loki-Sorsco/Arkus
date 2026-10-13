// Writes prisma/schema.postgres.prisma: the same models with the datasource switched to PostgreSQL
// (hosted Arkus). The SQLite schema stays the source of truth for the local tool.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const src = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const out = src.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
fs.writeFileSync(path.join(root, "prisma", "schema.postgres.prisma"), `// generated from schema.prisma by scripts/schema-postgres.mjs; do not edit\n${out}`);
console.log("prisma/schema.postgres.prisma written");
