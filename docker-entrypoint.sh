#!/bin/sh
# Apply the schema to Postgres (idempotent), then start the server.
set -e
: "${DATABASE_URL:?DATABASE_URL is required (postgres://…)}"
: "${ARKUS_SECRET_KEY:?ARKUS_SECRET_KEY is required (base64, 32 bytes: openssl rand -base64 32)}"
node node_modules/prisma/build/index.js db push --schema prisma/schema.postgres.prisma --skip-generate --accept-data-loss
exec node node_modules/next/dist/bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
