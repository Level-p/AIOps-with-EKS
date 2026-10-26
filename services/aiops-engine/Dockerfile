# CareSignal aiops-engine
# Base image pinned by digest (Dependabot proposes updates); dependencies installed
# with --require-hashes, so a tampered or substituted package fails the build.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS build
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes --prefix=/install -r requirements.txt

FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS runner
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app     && rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/bin/pip*   # no installer at run time
COPY --from=build /install /usr/local
WORKDIR /app
COPY --chown=root:root app ./app
USER 10001
EXPOSE 8080
# The engine reports its own metrics on /metrics; it does not need OpenTelemetry auto-instrumentation
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--no-access-log"]
