# Hosted Arkus (ARKUS_MODE=cloud): Google sign-in, Postgres metadata, repos cloned per user.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/schema-postgres.mjs \
 && npx prisma generate --schema prisma/schema.postgres.prisma \
 && NEXT_TELEMETRY_DISABLED=1 npx next build --webpack \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production ARKUS_MODE=cloud NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 ARKUS_REPOS_DIR=/data/repos
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh && mkdir -p /data/repos && chown -R node:node /data /app
USER node
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["./docker-entrypoint.sh"]
