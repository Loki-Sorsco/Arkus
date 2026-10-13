import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  devIndicators: false,
  // The published package is relocated into users' node_modules: trace from this folder only.
  outputFileTracingRoot: path.resolve(__dirname),
  serverExternalPackages: ["@prisma/client", "prisma", "pg", "mysql2", "typescript", "node-sql-parser"],
};

export default nextConfig;
