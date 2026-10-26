# CareSignal records-api (Node.js 24)
# Base images pinned by digest (Dependabot proposes updates). Dependencies come from the
# committed package-lock.json with integrity hashes (npm ci), install scripts disabled, and no
# dev dependencies. The runtime image is distroless: no shell, no package manager, non-root.
FROM node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:59c479c9b8c123e66047315c968aa2d35e31ae5149c856e4110a79c8b3563f0b
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
# Files are owned by root and read-only for the app user; the chart also mounts the root
# filesystem read-only and sets runAsUser 10001.
USER 10001
EXPOSE 8080
# The distroless entrypoint is "node". telemetry.js starts OpenTelemetry (traces + metrics over
# OTLP to the collector in OTEL_EXPORTER_OTLP_ENDPOINT) before the application is loaded.
CMD ["--require", "./src/telemetry.js", "src/server.js"]
