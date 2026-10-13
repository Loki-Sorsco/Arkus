import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["@prisma/client", "prisma", "pg", "mysql2", "typescript", "node-sql-parser"],
};

export default nextConfig;
