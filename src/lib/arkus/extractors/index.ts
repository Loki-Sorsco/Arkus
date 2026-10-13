// Ordered extractor registry: highest-confidence sources first.
import type { Extractor } from "../types";
import { prismaExtractor } from "./prisma";
import { openapiExtractor } from "./openapi";
import { sqlMigrationsExtractor } from "./sql-migrations";
import { nextjsExtractor } from "./nextjs";
import { nodeRoutesExtractor } from "./node-routes";
import { pythonExtractor } from "./python";
import { callersExtractor } from "./callers";
import { ormUsageExtractor } from "./orm-usage";
import { externalsExtractor } from "./externals";

export const extractors: Extractor[] = [
  prismaExtractor,
  openapiExtractor,
  sqlMigrationsExtractor,
  nextjsExtractor,
  nodeRoutesExtractor,
  pythonExtractor,
  callersExtractor,
  ormUsageExtractor,
  externalsExtractor,
];

export { prismaExtractor, openapiExtractor, sqlMigrationsExtractor, nextjsExtractor, nodeRoutesExtractor, pythonExtractor, callersExtractor, ormUsageExtractor, externalsExtractor };
