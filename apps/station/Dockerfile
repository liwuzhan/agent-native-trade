FROM node:24-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY protocol ./protocol
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/identity ./packages/identity
COPY packages/signed-files ./packages/signed-files
COPY packages/local-store ./packages/local-store
COPY packages/bt-catalog ./packages/bt-catalog
COPY apps/demo-indexer ./apps/demo-indexer
COPY apps/station ./apps/station

RUN npm ci --prefix packages/identity \
  && npm run build --prefix packages/identity \
  && npm ci --prefix packages/signed-files \
  && npm run build --prefix packages/signed-files \
  && npm ci --prefix packages/local-store \
  && npm run build --prefix packages/local-store \
  && npm ci --ignore-scripts --prefix packages/bt-catalog \
  && npm run build --prefix packages/bt-catalog \
  && npm ci --prefix apps/demo-indexer \
  && npm run build --prefix apps/demo-indexer \
  && npm ci --prefix apps/station \
  && npm run build --prefix apps/station

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
ENTRYPOINT ["node", "apps/station/dist/cli.js"]

