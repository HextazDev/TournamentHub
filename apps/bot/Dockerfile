FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY packages/shared ./packages/shared
COPY apps/bot ./apps/bot
RUN npm run build --workspace=@hub/shared
RUN npm run build --workspace=@hub/bot

FROM node:22-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --workspace=@hub/bot --workspace=@hub/shared && npm cache clean --force

FROM node:22-slim AS runner
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/ ./
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/apps/bot/dist ./apps/bot/dist
USER node
WORKDIR /app/apps/bot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
