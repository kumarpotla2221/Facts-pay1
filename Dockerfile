# ---- build: install everything, compile TypeScript, then drop the dev dependencies ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: only what the server needs, non-root ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/schools.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/demo-site ./demo-site
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
