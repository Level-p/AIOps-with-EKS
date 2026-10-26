# CareSignal vitals-ingest (Node.js 24)
# Base images pinned by digest (Dependabot proposes updates). Dependencies come from the
# committed package-lock.json with integrity hashes (npm ci), install scripts disabled, and no
# dev dependencies. The runtime image is distroless: no shell, no package manager, non-root.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src

# Files are owned by root and read-only for the app user; the chart also mounts the root
# filesystem read-only and sets runAsUser 10001.
USER 10001
EXPOSE 8080
# The distroless entrypoint is "node". telemetry.js starts OpenTelemetry (traces + metrics over
# OTLP to the collector in OTEL_EXPORTER_OTLP_ENDPOINT) before the application is loaded.
CMD ["--require", "./src/telemetry.js", "src/server.js"]
