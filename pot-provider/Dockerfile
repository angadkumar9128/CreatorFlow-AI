ARG BGUTIL_VERSION=2.0.0
FROM node:26-bookworm-slim AS build
ARG BGUTIL_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${BGUTIL_VERSION} https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git .
WORKDIR /src/server
RUN npm ci --no-audit --no-fund && npx tsc
RUN npm ci --omit=dev --no-audit --no-fund
FROM node:26-bookworm-slim
ENV NODE_ENV=production
USER node
WORKDIR /app
COPY --from=build --chown=node:node /src/server/node_modules ./node_modules
COPY --from=build --chown=node:node /src/server/build ./build
COPY --from=build --chown=node:node /src/server/package.json ./package.json
COPY --chown=node:node gateway.mjs ./gateway.mjs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","gateway.mjs"]
