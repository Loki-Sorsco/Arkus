// Stack detection from manifests + file layout. Cheap, no parsing of source.
import type { Detected, RepoFile } from "./types";

type Pkg = { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] | { packages: string[] } };

export async function detectStack(files: RepoFile[], read: (rel: string) => Promise<string>): Promise<Detected> {
  const det: Detected = { languages: [], frameworks: [], orms: [], apps: [], summary: "" };
  const has = (re: RegExp) => files.some((f) => re.test(f.rel));
  const add = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };

  if (has(/\.(ts|tsx)$/)) add(det.languages, "ts");
  if (has(/\.(js|jsx|mjs|cjs)$/)) add(det.languages, "js");
  if (has(/\.py$/)) add(det.languages, "py");
  if (has(/\.go$/)) add(det.languages, "go");
  if (has(/\.(java|kt)$/)) add(det.languages, "java");
  if (has(/\.php$/)) add(det.languages, "php");
  if (has(/\.rb$/)) add(det.languages, "ruby");

  const pkgFiles = files.filter((f) => /(^|\/)package\.json$/.test(f.rel) && f.rel.split("/").length <= 4);
  const deps: Record<string, string> = {};
  let rootPkg: Pkg | null = null;
  for (const f of pkgFiles) {
    try {
      const pkg = JSON.parse(await read(f.rel)) as Pkg;
      Object.assign(deps, pkg.dependencies, pkg.devDependencies);
      if (f.rel === "package.json") rootPkg = pkg;
      const dir = f.rel.replace(/\/?package\.json$/, "") || ".";
      if (dir !== ".") {
        const d = { ...pkg.dependencies, ...pkg.devDependencies };
        const role = d.next || d.react || d.vue || d.svelte ? (d.express || d.fastify || d["@nestjs/core"] ? "fullstack" : "frontend")
          : d.express || d.fastify || d["@nestjs/core"] || d.hono || d.koa ? "backend" : "library";
        det.apps.push({ name: pkg.name || dir.split("/").pop() || dir, dir, role });
      }
    } catch { /* bad json */ }
  }
  if (rootPkg?.workspaces) {
    const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages;
    det.monorepo = { tool: has(/pnpm-workspace\.yaml$/) ? "pnpm" : has(/turbo\.json$/) ? "turbo" : "npm", packages: ws };
  } else if (has(/pnpm-workspace\.yaml$/)) det.monorepo = { tool: "pnpm", packages: [] };
  if (has(/^pnpm-lock\.yaml$/)) det.packageManager = "pnpm";
  else if (has(/^yarn\.lock$/)) det.packageManager = "yarn";
  else if (has(/^bun\.lockb?$/)) det.packageManager = "bun";
  else if (has(/^package-lock\.json$/)) det.packageManager = "npm";

  const fw: [string, () => boolean][] = [
    ["nextjs", () => !!deps.next || has(/(^|\/)next\.config\.(js|mjs|ts)$/)],
    ["nestjs", () => !!deps["@nestjs/core"]],
    ["express", () => !!deps.express],
    ["fastify", () => !!deps.fastify],
    ["hono", () => !!deps.hono],
    ["koa", () => !!deps.koa],
    ["trpc", () => !!deps["@trpc/server"]],
    ["remix", () => !!deps["@remix-run/node"] || !!deps["@react-router/node"]],
    ["nuxt", () => !!deps.nuxt],
    ["sveltekit", () => !!deps["@sveltejs/kit"]],
    ["react", () => !!deps.react],
    ["vue", () => !!deps.vue],
    ["graphql", () => !!deps.graphql || !!deps["apollo-server"] || !!deps["@apollo/server"]],
  ];
  for (const [n, t] of fw) if (t()) add(det.frameworks, n);
  const orm: [string, () => boolean][] = [
    ["prisma", () => !!deps.prisma || !!deps["@prisma/client"] || has(/(^|\/)schema\.prisma$/)],
    ["drizzle", () => !!deps["drizzle-orm"]],
    ["typeorm", () => !!deps.typeorm],
    ["sequelize", () => !!deps.sequelize],
    ["mongoose", () => !!deps.mongoose],
    ["knex", () => !!deps.knex],
    ["kysely", () => !!deps.kysely],
    ["supabase", () => !!deps["@supabase/supabase-js"]],
  ];
  for (const [n, t] of orm) if (t()) add(det.orms, n);

  // Python
  const pyManifests = files.filter((f) => /(^|\/)(requirements.*\.txt|pyproject\.toml|Pipfile)$/.test(f.rel));
  let py = "";
  for (const f of pyManifests) py += (await read(f.rel)).toLowerCase() + "\n";
  if (/\bfastapi\b/.test(py)) add(det.frameworks, "fastapi");
  if (/\bflask\b/.test(py)) add(det.frameworks, "flask");
  if (/\bdjango\b/.test(py) || has(/(^|\/)manage\.py$/)) add(det.frameworks, "django");
  if (/\bsqlalchemy\b/.test(py)) add(det.orms, "sqlalchemy");
  if (/\bdjango\b/.test(py)) add(det.orms, "django-orm");
  if (/\balembic\b/.test(py)) add(det.orms, "alembic");
  // Go / others
  if (has(/^go\.mod$/)) add(det.frameworks, "go");
  if (has(/(^|\/)openapi\.(json|ya?ml)$|(^|\/)swagger\.(json|ya?ml)$/)) add(det.frameworks, "openapi");
  if (has(/(^|\/)supabase\/migrations\//)) add(det.orms, "supabase-sql");

  // DB engine hint (names only)
  const prismaSchema = files.find((f) => /(^|\/)schema\.prisma$/.test(f.rel));
  if (prismaSchema) {
    const m = (await read(prismaSchema.rel)).match(/provider\s*=\s*"(postgresql|mysql|sqlite|mongodb|sqlserver|cockroachdb)"/);
    if (m) det.dbEngineHint = m[1];
  }
  if (!det.dbEngineHint) {
    if (deps.pg || deps.postgres || /psycopg|asyncpg/.test(py)) det.dbEngineHint = "postgresql";
    else if (deps.mysql2 || deps.mysql || /pymysql|mysqlclient/.test(py)) det.dbEngineHint = "mysql";
    else if (deps["better-sqlite3"] || deps.sqlite3) det.dbEngineHint = "sqlite";
    else if (deps.mongoose || deps.mongodb || /pymongo|motor/.test(py)) det.dbEngineHint = "mongodb";
  }
  if (det.apps.length === 0) det.apps.push({ name: rootPkg?.name || "app", dir: ".", role: det.frameworks.includes("nextjs") ? "fullstack" : det.frameworks.some((f) => ["express","nestjs","fastify","hono","fastapi","flask","django","go"].includes(f)) ? "backend" : det.frameworks.some((f) => ["react","vue"].includes(f)) ? "frontend" : "unknown" });

  const label = (n: string) => ({ nextjs: deps.next ? `Next.js ${String(deps.next).replace(/[\^~]/, "").split(".")[0]}` : "Next.js", nestjs: "NestJS", express: "Express", fastify: "Fastify", hono: "Hono", koa: "Koa", trpc: "tRPC", remix: "Remix", nuxt: "Nuxt", sveltekit: "SvelteKit", react: "React", vue: "Vue", graphql: "GraphQL", fastapi: "FastAPI", flask: "Flask", django: "Django", go: "Go", openapi: "OpenAPI" }[n] || n);
  const ormLabel = (n: string) => ({ prisma: "Prisma", drizzle: "Drizzle", typeorm: "TypeORM", sequelize: "Sequelize", mongoose: "Mongoose", knex: "Knex", kysely: "Kysely", supabase: "Supabase", sqlalchemy: "SQLAlchemy", "django-orm": "Django ORM", alembic: "Alembic", "supabase-sql": "Supabase SQL" }[n] || n);
  const engine = ({ postgresql: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", mongodb: "MongoDB", sqlserver: "SQL Server", cockroachdb: "CockroachDB" } as Record<string, string>)[det.dbEngineHint || ""];
  const parts = [...det.frameworks.filter((f) => f !== "react" || det.frameworks.length === 1).slice(0, 3).map(label), ...det.orms.slice(0, 2).map(ormLabel), engine].filter(Boolean);
  det.summary = parts.join(" · ") || "Unknown stack";
  return det;
}
