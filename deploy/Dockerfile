# One image for both processes. From the repository root:
#   docker build -f deploy/Dockerfile -t agir .
# API:    node_modules/.bin/tsx apps/api/src/main.ts      (the default command)
# Worker: node_modules/.bin/tsx apps/worker/src/main.ts

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w @agir/web

FROM node:22-bookworm-slim
WORKDIR /app
# The PDF renderer (packages/artifacts/src/pdf.ts) launches Playwright's own headless Chromium
# when AGIR_CHROMIUM_PATH is unset; it is installed here, outside any home folder.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app /app
RUN npx --no-install playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data
USER node
ENV AGIR_DATA_DIR=/data AGIR_BIND=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]
