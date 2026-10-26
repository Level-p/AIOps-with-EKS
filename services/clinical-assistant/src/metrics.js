// LLM operations metrics (OpenTelemetry). After the collector's Prometheus conversion they are
// caresignal_llm_*; the alerts in the Helm chart and aiops-engine's anomaly signals use them.
const { metrics } = require("@opentelemetry/api");

const meter = metrics.getMeter("caresignal.clinical-assistant");

module.exports = {
  REQUESTS: meter.createCounter("caresignal.llm.requests", {
    unit: "{request}", description: "Assistant requests, by feature and outcome (ok, fallback, blocked, error, refused, ungrounded)",
  }),
  TOKENS: meter.createCounter("caresignal.llm.tokens", { unit: "{token}", description: "Model tokens, by feature and direction (input, output)" }),
  DURATION: meter.createHistogram("caresignal.llm.duration", {
    unit: "s", description: "Model call duration, by feature",
    advice: { explicitBucketBoundaries: [0.5, 1, 2, 4, 8, 15, 30, 60] },
  }),
  BLOCKS: meter.createCounter("caresignal.llm.guardrail.blocks", {
    unit: "{request}", description: "Requests refused by a guardrail before the model, by reason",
  }),
  INJECTION_SUSPECTED: meter.createCounter("caresignal.llm.injection.suspected", {
    unit: "{item}", description: "Record items whose text looks like a prompt injection (sent as data, counted)",
  }),
  GROUNDING_FAILURES: meter.createCounter("caresignal.llm.grounding.failures", {
    unit: "{statement}", description: "Model statements dropped or withheld because they cited nothing in the record",
  }),
  SAFETY_FLAGS: meter.createCounter("caresignal.llm.safety.flags", { unit: "{flag}", description: "Deterministic safety checks raised, by type" }),
  meter,
};
