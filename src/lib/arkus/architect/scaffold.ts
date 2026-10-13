// Writes a runnable Next.js 16 + Prisma starter from a Blueprint. Never runs npm. Never writes outside targetDir.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blueprint } from "./schema";
import { blueprintToGraph, endpointRef } from "./schema";
import { toPrismaSchema, routeFileFor, pageFileFor } from "./export";
import { routeFile, pageFile } from "./scaffold-code";

export type ScaffoldStack = { database?: "sqlite" | "postgresql" | "mysql" };
export type ScaffoldInput = { bp: Blueprint; targetDir: string; stack?: ScaffoldStack; force?: boolean; blueprintVersion?: number };
export type ScaffoldResult = { targetDir: string; files: string[]; nextSteps: string[] };

const q = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

/** All files as { relPath: content }. Pure; used by scaffoldProject and tests. */
export function scaffoldFiles(bp: Blueprint, stack: ScaffoldStack = {}, blueprintVersion = 1): Record<string, string> {
  const db = stack.database ?? "sqlite";
  const slug = bp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  const files: Record<string, string> = {};

  files["package.json"] = q({
    name: slug, version: "0.1.0", private: true,
    scripts: { dev: "next dev", build: "prisma generate && next build", start: "next start", lint: "eslint", typecheck: "tsc --noEmit", "db:push": "prisma db push", "db:studio": "prisma studio", postinstall: "prisma generate" },
    dependencies: { next: "16.3.4", react: "19.2.8", "react-dom": "19.2.8", "@prisma/client": "^6.16.0", zod: "^3.25.76" },
    devDependencies: { "@tailwindcss/postcss": "^4", "@types/node": "^20", "@types/react": "^19", "@types/react-dom": "^19", eslint: "^9", "eslint-config-next": "16.3.4", prisma: "^6.16.0", tailwindcss: "^4", typescript: "^5" },
  });
  files["tsconfig.json"] = q({
    compilerOptions: { target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "react-jsx", incremental: true, plugins: [{ name: "next" }], paths: { "@/*": ["./src/*"] } },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"],
  });
  files["next.config.ts"] = `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`;
  files["postcss.config.mjs"] = `const config = { plugins: { "@tailwindcss/postcss": {} } };\nexport default config;\n`;
  files["eslint.config.mjs"] = `import nextVitals from "eslint-config-next/core-web-vitals";\nimport nextTs from "eslint-config-next/typescript";\n\nexport default [...nextVitals, ...nextTs, { ignores: [".next/**", "node_modules/**"] }];\n`;
  files[".gitignore"] = "node_modules\n.next\n.env\n*.db\n*.db-journal\n";
  files[".env.example"] = db === "sqlite" ? `DATABASE_URL="file:./dev.db"\nSESSION_SECRET="change-me-to-a-long-random-string"\n` : `DATABASE_URL="${db === "postgresql" ? "postgresql://user:pass@localhost:5432/" + slug : "mysql://user:pass@localhost:3306/" + slug}"\nSESSION_SECRET="change-me-to-a-long-random-string"\n`;
  files["prisma/schema.prisma"] = toPrismaSchema(bp, db);

  files["src/app/globals.css"] = `@import "tailwindcss";\n\n:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb; }\n@media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --fg: #fafaf9; --muted: #a8a29e; --line: #292524; } }\nbody { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; }\n.nav { display: flex; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); font-size: 14px; }\n.nav a { color: var(--muted); text-decoration: none; } .nav a:hover { color: var(--fg); }\n.page { max-width: 720px; margin: 0 auto; padding: 24px 16px; }\n.form { display: grid; gap: 12px; margin: 16px 0; }\n.form label { display: grid; gap: 4px; font-size: 14px; }\n.input, select, textarea { border: 1px solid var(--line); background: transparent; color: inherit; padding: 8px 10px; border-radius: 6px; font: inherit; }\nbutton { background: var(--accent); color: white; border: 0; padding: 10px 14px; border-radius: 6px; font: inherit; cursor: pointer; }\n.table { width: 100%; border-collapse: collapse; font-size: 14px; } .table td { border-bottom: 1px solid var(--line); padding: 6px 8px; }\n.result { font-size: 12px; color: var(--muted); white-space: pre-wrap; }\n`;
  const navPages = bp.pages.filter((p) => !p.path.includes(":"));
  files["src/app/layout.tsx"] = `import type { Metadata } from "next";\nimport Link from "next/link";\nimport "./globals.css";\n\nexport const metadata: Metadata = { title: ${JSON.stringify(bp.name)}, description: ${JSON.stringify(bp.summary.slice(0, 160))} };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        <nav className="nav">\n          <Link href="/"><b>${bp.name.replace(/[{}<>]/g, "")}</b></Link>\n${navPages.map((p) => `          <Link href=${JSON.stringify(p.path)}>${p.name.replace(/[{}<>]/g, "")}</Link>`).join("\n")}\n        </nav>\n        {children}\n      </body>\n    </html>\n  );\n}\n`;
  if (!bp.pages.some((p) => p.path === "/")) {
    files["src/app/page.tsx"] = `export default function Home() {\n  return (\n    <main className="page">\n      <h1>${bp.name.replace(/[{}<>]/g, "")}</h1>\n      <p>${bp.summary.replace(/[{}<>]/g, "")}</p>\n      <ul>\n${navPages.map((p) => `        <li><a href=${JSON.stringify(p.path)}>${p.name.replace(/[{}<>]/g, "")}</a></li>`).join("\n")}\n      </ul>\n    </main>\n  );\n}\n`;
  }
  files["src/lib/db.ts"] = `import { PrismaClient } from "@prisma/client";\n\nconst g = globalThis as unknown as { prisma?: PrismaClient };\nexport const prisma = g.prisma ?? new PrismaClient();\nif (process.env.NODE_ENV !== "production") g.prisma = prisma;\n`;
  files["src/lib/auth.ts"] = AUTH_TS;

  const byPath = new Map<string, typeof bp.endpoints>();
  for (const ep of bp.endpoints) byPath.set(ep.path, [...(byPath.get(ep.path) ?? []), ep]);
  for (const [p, eps] of byPath) files[routeFileFor(p)] = routeFile(eps, bp, db);
  for (const p of bp.pages) files[pageFileFor(p.path)] = pageFile(p, bp);

  const graph = blueprintToGraph(bp);
  files["arkus.json"] = q({
    blueprintVersion, generatedAt: new Date().toISOString(), generator: "arkus-architect", name: bp.name,
    stack: { ...bp.stack, database: db },
    endpoints: bp.endpoints.map((e) => ({ ref: endpointRef(e), file: routeFileFor(e.path), auth: e.auth, reads: e.reads, writes: e.writes })),
    pages: bp.pages.map((p) => ({ path: p.path, file: pageFileFor(p.path), calls: p.calls })),
    tables: bp.entities.map((e) => ({ table: e.table, model: e.name, columns: e.columns.map((c) => c.name) })),
    bindings: graph.bindings,
  });
  files["README.md"] = readme(bp, db);
  return files;
}

export async function scaffoldProject(input: ScaffoldInput): Promise<ScaffoldResult> {
  const root = path.resolve(input.targetDir);
  if (!path.isAbsolute(input.targetDir) || root === path.parse(root).root) throw new Error("targetDir must be an absolute, non-root path");
  const st = await fs.stat(root).catch(() => null);
  if (st && !st.isDirectory()) throw new Error("targetDir exists and is not a directory");
  if (st) {
    const entries = (await fs.readdir(root)).filter((e) => e !== ".git" && e !== ".DS_Store");
    if (entries.length && !input.force) throw new Error(`targetDir is not empty (${entries.length} entries); pass force to overwrite`);
  }
  const files = scaffoldFiles(input.bp, input.stack, input.blueprintVersion ?? 1);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    if (rel.split(/[\\/]/).some((seg) => seg === ".." || seg === "")) throw new Error(`unsafe path ${rel}`);
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) throw new Error(`refusing to write outside targetDir: ${rel}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    written.push(rel);
  }
  return { targetDir: root, files: written, nextSteps: nextSteps(input.stack?.database ?? "sqlite") };
}

const nextSteps = (db: string) => [
  "npm install", "copy .env.example to .env" + (db === "sqlite" ? "" : " and set DATABASE_URL"), "npx prisma db push", "npm run dev → http://localhost:3000",
  "Open the project in Arkus (it is now a connected project) and run Index to see pages → APIs → tables",
];

function readme(bp: Blueprint, db: string): string {
  return `# ${bp.name}\n\n${bp.summary}\n\nGenerated by **Arkus Architect**. Stack: ${bp.stack.frontend} · ${bp.stack.backend} · ${db} via Prisma.\n\n## Run\n\n\`\`\`bash\nnpm install\ncp .env.example .env\nnpx prisma db push\nnpm run dev\n\`\`\`\n\nOpen http://localhost:3000.\n\n## What is here\n\n- \`prisma/schema.prisma\` — ${bp.entities.length} models (${bp.entities.map((e) => e.table).join(", ")})\n- \`src/app/api/**/route.ts\` — ${bp.endpoints.length} endpoints with zod validation and Prisma calls\n- \`src/app/**/page.tsx\` — ${bp.pages.length} pages; forms post to their bound endpoint\n- \`src/lib/auth.ts\` — minimal signed-cookie sessions + scrypt password hashing (replace with your auth provider when ready)\n- \`arkus.json\` — page field → API key → column bindings so Arkus can re-import this repo\n\n## Endpoints\n\n${bp.endpoints.map((e) => `- \`${endpointRef(e)}\` — ${e.name}${e.auth ? " (auth)" : ""}`).join("\n")}\n\n## Assumptions\n\n${bp.assumptions.map((a) => `- ${a.text}`).join("\n") || "- none"}\n`;
}

const AUTH_TS = `// Minimal session + password helpers. Swap for NextAuth/Clerk/Lucia when you outgrow it.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";

const SECRET = () => process.env.SESSION_SECRET || "dev-secret-change-me";
const COOKIE = "session";

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(pw, salt, 64).toString("hex");
}
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex"); const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
const sign = (v: string) => createHmac("sha256", SECRET()).update(v).digest("base64url");
export function setSessionCookie(res: NextResponse, userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString("base64url");
  res.cookies.set(COOKIE, payload + "." + sign(payload), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
}
export async function requireSession(req: Request): Promise<{ userId: string } | null> {
  const raw = req.headers.get("cookie")?.split(/;\\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || sign(payload) !== sig) return null;
  try { const { userId } = JSON.parse(Buffer.from(payload, "base64url").toString()); return typeof userId === "string" ? { userId } : null; } catch { return null; }
}
`;
