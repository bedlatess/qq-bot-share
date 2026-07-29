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
COPY --from=build /app/packages/shared/dist packages/shared/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 17866
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:17866/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/control/dist/main.js"]
