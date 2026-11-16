# ---- build: install API dependencies, compile TypeScript, then drop dev dependencies ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/
RUN npm ci --workspace=@facts-pay/api --include-workspace-root=false
COPY apps/api ./apps/api
RUN npm run build:api \
    && npm prune --omit=dev --workspace=@facts-pay/api --include-workspace-root=false \
    && mkdir -p apps/api/node_modules

# ---- runtime: only what the server needs, non-root ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json /app/apps/api/schools.json ./apps/api/
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/public ./apps/api/public
COPY --from=build /app/apps/api/schools-sql ./apps/api/schools-sql
COPY --from=build /app/apps/api/demo-site ./apps/api/demo-site
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
