FROM node:22-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control/package.json apps/control/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .
RUN npm run build
RUN tar -czf /app/puff-agent-update.tar.gz \
      package.json package-lock.json \
      tsconfig.base.json \
      apps/agent/package.json apps/agent/tsconfig.json apps/agent/agent.config.example.json \
      apps/agent/src apps/agent/dist \
      packages/shared/package.json packages/shared/tsconfig.json \
      packages/shared/src packages/shared/dist \
      scripts/windows

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=17866 \
    DATA_DIR=/app/data \
    PUBLIC_DIR=/app/apps/control/public
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control/package.json apps/control/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/control/dist apps/control/dist
COPY --from=build /app/apps/control/public apps/control/public
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/puff-agent-update.tar.gz puff-agent-update.tar.gz
RUN chmod 0644 package.json package-lock.json \
      apps/control/package.json apps/agent/package.json apps/web/package.json \
      packages/shared/package.json \
    && chmod -R a+rX apps/control/dist apps/control/public packages/shared/dist \
    && mkdir -p /app/data \
    && chown -R node:node /app/data
USER node
RUN node -e "import('@puff/shared').then(() => console.log('shared package ok'))"
EXPOSE 17866
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:17866/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/control/dist/main.js"]
