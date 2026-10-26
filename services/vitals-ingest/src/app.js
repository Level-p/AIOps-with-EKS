// vitals-ingest: receives readings from (simulated) bedside and wearable devices.
//
// POST /v1/readings  (header X-Device-Token)
//   1. authenticates the device (constant-time token check)
//   2. validates the reading (physiologically possible ranges)
//   3. scores it (NEWS2-style early warning score)
//   4. forwards it to records-api, which stores it in the patient's record
//
// Telemetry: the trace continues into records-api (fetch is instrumented); metrics
// caresignal.vitals.* feed the alerts and aiops-engine's anomaly detection. Only the
// opaque patient id is ever logged.
const express = require("express");
const { metrics, trace } = require("@opentelemetry/api");
const { z } = require("zod");
const { safeEqual, securityHeaders, noStore, notFound, errorHandler } = require("./common");
const { score } = require("./scoring");

const meter = metrics.getMeter("caresignal.vitals-ingest");
const INGESTED = meter.createCounter("caresignal.vitals.ingested", { unit: "{reading}", description: "Readings accepted, by risk level" });
const REJECTED = meter.createCounter("caresignal.vitals.rejected", { unit: "{reading}", description: "Readings refused, by reason" });
const STORE_FAILURES = meter.createCounter("caresignal.vitals.forward_failures", {
  unit: "{reading}", description: "Readings that could not be stored in records-api",
});

const Reading = z.strictObject({
  patient_id: z.uuid(),
  device_id: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  heart_rate: z.int().min(20).max(250),
  respiratory_rate: z.int().min(2).max(70),
  spo2: z.int().min(50).max(100),
  systolic_bp: z.int().min(40).max(300),
  temperature: z.number().min(30).max(45),
  recorded_at: z.iso.datetime({ offset: true }).optional(),
});

// store(reading) sends the scored reading to records-api; tests pass a fake
function recordsApiStore({ url, internalToken, timeoutMs = 5000 }) {
  return async (reading) => {
    const res = await fetch(`${url}/internal/readings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify(reading),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`records-api answered ${res.status}`);
  };
}

function createApp({ deviceToken, store, log }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders, noStore, express.json({ limit: "8kb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.post("/v1/readings", async (req, res) => {
    if (!safeEqual(req.get("x-device-token"), deviceToken)) {
      REJECTED.add(1, { reason: "unauthenticated" });
      return res.status(401).json({ error: "invalid device token" });
    }
    const parsed = Reading.safeParse(req.body);
    if (!parsed.success) {
      REJECTED.add(1, { reason: "invalid" });
      return res.status(422).json({ error: "invalid reading", fields: parsed.error.issues.map((i) => i.path.join(".")) });
    }
    const reading = parsed.data;
    const result = score(reading);
    const span = trace.getActiveSpan();
    span?.setAttributes({ "caresignal.risk": result.risk, "caresignal.score": result.score });

    try {
      await store({ ...reading, recorded_at: reading.recorded_at || new Date().toISOString(), score: result.score, risk: result.risk });
    } catch (err) {
      STORE_FAILURES.add(1);
      log.error({ error: err.name }, "could not store reading");
      return res.status(503).json({ error: "storage unavailable, retry later" });
    }

    INGESTED.add(1, { risk: result.risk });
    if (result.risk === "high") {
      // Clinical escalation is the ward's alerting system's job; here it is a signal for monitoring
      log.warn({ patient_id: reading.patient_id, score: result.score }, "high early-warning score");
    }
    res.status(202).json({ accepted: true, ...result });
  });

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

module.exports = { createApp, recordsApiStore, Reading };
