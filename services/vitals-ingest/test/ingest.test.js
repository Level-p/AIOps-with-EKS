const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const pino = require("pino");
const { createApp } = require("../src/app");
const { score } = require("../src/scoring");

const PATIENT = "8d0f4a52-35f6-4a8e-9a4e-1f0c7f2b9a11";
const normal = { patient_id: PATIENT, device_id: "bed-1.monitor", heart_rate: 72, respiratory_rate: 16, spo2: 98, systolic_bp: 124, temperature: 36.8 };
const log = pino({ level: "silent" });

function app(store = async () => {}) {
  return createApp({ deviceToken: "device-secret", store, log });
}

test("NEWS2: normal vitals are low risk", () => {
  assert.deepEqual(score(normal).score, 0);
  assert.equal(score(normal).risk, "low");
});

test("NEWS2: deteriorating patient is high risk", () => {
  const r = score({ heart_rate: 135, respiratory_rate: 26, spo2: 90, systolic_bp: 88, temperature: 39.4 });
  assert.equal(r.risk, "high");
  assert.equal(r.score, 3 + 3 + 3 + 3 + 2);
});

test("NEWS2: a single extreme parameter is at least medium", () => {
  const r = score({ ...normal, respiratory_rate: 7 });
  assert.equal(r.score, 3);
  assert.equal(r.risk, "medium");
});

test("NEWS2: band edges", () => {
  assert.equal(score({ ...normal, heart_rate: 90 }).parts.heart_rate, 0);
  assert.equal(score({ ...normal, heart_rate: 91 }).parts.heart_rate, 1);
  assert.equal(score({ ...normal, temperature: 38.04 }).parts.temperature, 0);
  assert.equal(score({ ...normal, systolic_bp: 220 }).parts.systolic_bp, 3);
});

test("rejects a missing or wrong device token", async () => {
  await request(app()).post("/v1/readings").send(normal).expect(401);
  await request(app()).post("/v1/readings").set("X-Device-Token", "nope").send(normal).expect(401);
});

test("rejects impossible values and unknown fields", async () => {
  const res = await request(app()).post("/v1/readings").set("X-Device-Token", "device-secret")
    .send({ ...normal, spo2: 140 }).expect(422);
  assert.deepEqual(res.body.fields, ["spo2"]);
  await request(app()).post("/v1/readings").set("X-Device-Token", "device-secret").send({ ...normal, name: "x" }).expect(422);
  await request(app()).post("/v1/readings").set("X-Device-Token", "device-secret").send({ ...normal, patient_id: "1 OR 1=1" }).expect(422);
});

test("scores, forwards and accepts a valid reading", async () => {
  const stored = [];
  const res = await request(app(async (r) => stored.push(r))).post("/v1/readings")
    .set("X-Device-Token", "device-secret").send(normal).expect(202);
  assert.equal(res.body.risk, "low");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].score, 0);
  assert.ok(stored[0].recorded_at);
});

test("answers 503 when records-api cannot store the reading", async () => {
  await request(app(async () => { throw new Error("down"); })).post("/v1/readings")
    .set("X-Device-Token", "device-secret").send(normal).expect(503);
});

test("security headers and no caching", async () => {
  const res = await request(app()).get("/healthz").expect(200);
  assert.match(res.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-powered-by"], undefined);
});

test("malformed JSON is a 400 without details", async () => {
  const res = await request(app()).post("/v1/readings").set("X-Device-Token", "device-secret")
    .set("content-type", "application/json").send("{bad").expect(400);
  assert.deepEqual(res.body, { error: "invalid request body" });
});

// Found by the DAST scan (ZAP 10055): Express's own 404 page replaced the CSP with default-src 'none'
test("unknown paths and methods answer 404 with the full security headers", async () => {
  for (const [method, path] of [["get", "/v1/readings"], ["get", "/nope"]]) {
    const res = await request(app())[method](path).expect(404);
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  }
});
