// OpenTelemetry for this service. Loaded before the application with
//   node --require ./src/telemetry.js src/server.js
// so the auto-instrumentations can patch http, express, pg, undici (fetch) and pino
// before those modules are first required.
//
// Everything is configured by the standard OTEL_* variables set in the Helm chart:
// OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_TRACES_SAMPLER(_ARG),
// OTEL_SEMCONV_STABILITY_OPT_IN=http (stable metric http.server.request.duration, in seconds).
// Traces and metrics go over OTLP/gRPC to the gateway collector. Logs stay on stdout as
// JSON with trace_id/span_id (added by the pino instrumentation); the node agent ships them.
// OTEL_SDK_DISABLED=true (tests, local runs) turns all of it off; the API then is a no-op.

let shutdown = async () => {};

if (process.env.OTEL_SDK_DISABLED !== "true") {
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-grpc");
  const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");

  const NOT_TRACED = new Set(["/healthz", "/readyz"]); // probes every 10 s would drown real traffic

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15000),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (req) => NOT_TRACED.has((req.url || "").split("?")[0]),
        },
      }),
    ],
  });
  sdk.start();
  shutdown = () => sdk.shutdown();
}

module.exports = { shutdown: () => shutdown() };
