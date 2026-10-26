const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const pino = require("pino");
const { newDb } = require("pg-mem");
const { createApp } = require("../src/app");
const { createRepository } = require("../src/db");

const CLIN = { Authorization: "Bearer clinician-secret" };
const INTERNAL = { "X-Internal-Token": "internal-secret" };
const AS_ASSISTANT = (purpose) => ({ ...CLIN, ...INTERNAL, "X-Access-Purpose": purpose });

async function setup() {
  const { Pool } = newDb().adapters.createPg();
  const repo = createRepository(new Pool());
  await repo.migrate();
  const app = createApp({ repo, clinicianToken: "clinician-secret", internalToken: "internal-secret", log: pino({ level: "silent" }) });
  const created = await request(app).post("/api/patients").set(CLIN)
    .send({ pseudonym: "Bed 4 - P-1234", ward: "A1", age_band: "65-79", sex: "female" }).expect(201);
  return { app, repo, pid: created.body.id };
}

const reading = (pid, extra = {}) => ({
  patient_id: pid, device_id: "bed-4.monitor", heart_rate: 120, respiratory_rate: 25, spo2: 91, systolic_bp: 95,
  temperature: 38.7, score: 12, risk: "high", recorded_at: "2026-10-18T10:00:00Z", ...extra,
});

test("every clinician route needs the bearer token (and the Bearer scheme)", async () => {
  const { app, pid } = await setup();
  await request(app).get("/api/patients").expect(401);
  await request(app).get("/api/patients").set("Authorization", "clinician-secret").expect(401);
  await request(app).get(`/api/patients/${pid}`).set("Authorization", "Bearer wrong").expect(401);
});

test("internal routes need the internal token", async () => {
  const { app, pid } = await setup();
  await request(app).post("/internal/readings").send(reading(pid)).expect(401);
  await request(app).post("/internal/readings").set(CLIN).send(reading(pid)).expect(401);
});

test("the full record: readings, medications, allergies, problems, notes; ward list shows latest risk", async () => {
  const { app, pid } = await setup();
  await request(app).post("/internal/readings").set(INTERNAL).send(reading(pid, { recorded_at: "2026-10-18T09:00:00Z", score: 1, risk: "low" })).expect(201);
  await request(app).post("/internal/readings").set(INTERNAL).send(reading(pid)).expect(201);
  // an older reading arriving late does not replace the latest score
  await request(app).post("/internal/readings").set(INTERNAL).send(reading(pid, { recorded_at: "2026-10-18T08:00:00Z", score: 0, risk: "low" })).expect(201);
  await request(app).post(`/api/patients/${pid}/medications`).set(CLIN)
    .send({ name: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "three times daily" }).expect(201);
  await request(app).post(`/api/patients/${pid}/allergies`).set(CLIN).send({ substance: "Penicillin", reaction: "rash", severity: "moderate" }).expect(201);
  await request(app).post(`/api/patients/${pid}/problems`).set(CLIN).send({ description: "Community-acquired pneumonia" }).expect(201);
  await request(app).post(`/api/patients/${pid}/notes`).set(CLIN).send({ kind: "progress", body: "Febrile overnight, more breathless." }).expect(201);

  const rec = (await request(app).get(`/api/patients/${pid}`).set(CLIN).expect(200)).body;
  assert.equal(rec.readings.length, 3);
  assert.equal(rec.readings[0].score, 12);
  assert.equal(rec.medications[0].name, "Amoxicillin");
  assert.equal(rec.allergies[0].substance, "Penicillin");
  assert.equal(rec.problems[0].status, "active");
  assert.equal(rec.notes[0].status, "final");

  const list = (await request(app).get("/api/patients?ward=A1").set(CLIN).expect(200)).body.patients;
  assert.equal(list[0].latest_risk, "high");
  assert.equal(list[0].latest_score, 12);
});

test("input validation: injection strings, unknown fields, bad ids", async () => {
  const { app, pid } = await setup();
  await request(app).post("/api/patients").set(CLIN).send({ pseudonym: "x'; DROP TABLE patients;--", ward: "A1" }).expect(422);
  await request(app).post("/api/patients").set(CLIN).send({ pseudonym: "Bed 1", ward: "A1", nhs_number: "1" }).expect(422);
  await request(app).post(`/api/patients/${pid}/medications`).set(CLIN).send({ name: "<script>", dose: "1", route: "oral", frequency: "x" }).expect(422);
  await request(app).get("/api/patients/1%20OR%201=1").set(CLIN).expect(404);
  await request(app).get("/api/patients/00000000-0000-4000-8000-000000000000").set(CLIN).expect(404);
  await request(app).get("/api/patients?ward=A1'--").set(CLIN).expect(200);
  await request(app).post("/internal/readings").set(INTERNAL).send(reading("00000000-0000-4000-8000-000000000000")).expect(404);
});

test("every access is audited with its purpose", async () => {
  const { app, pid } = await setup();
  await request(app).get(`/api/patients/${pid}`).set(CLIN).expect(200);
  await request(app).get(`/api/patients/${pid}`).set(AS_ASSISTANT("ai-summary")).expect(200);
  const events = (await request(app).get(`/api/patients/${pid}/audit`).set(CLIN).expect(200)).body.events;
  const reads = events.filter((e) => e.action === "read").map((e) => [e.actor, e.purpose]);
  assert.deepEqual(reads.sort(), [["clinician", "care"], ["clinician via clinical-assistant", "ai-summary"]].sort());
  assert.ok(events.some((e) => e.action === "create"));
});

test("access purposes: unknown purposes rejected; AI purposes only through the assistant", async () => {
  const { app, pid } = await setup();
  await request(app).get(`/api/patients/${pid}`).set({ ...CLIN, "X-Access-Purpose": "marketing" }).expect(400);
  await request(app).get(`/api/patients/${pid}`).set({ ...CLIN, "X-Access-Purpose": "ai-summary" }).expect(403);
});

test("human in the loop: the assistant writes drafts, only a clinician signs them", async () => {
  const { app, pid } = await setup();
  // a draft needs both credentials
  await request(app).post(`/internal/patients/${pid}/drafts`).set(INTERNAL).send({ kind: "discharge", body: "Draft", model: "m" }).expect(401);
  const draft = (await request(app).post(`/internal/patients/${pid}/drafts`).set(AS_ASSISTANT("ai-draft"))
    .send({ kind: "discharge", body: "Draft discharge summary [N1]", model: "claude-opus-5-5" }).expect(201)).body;
  assert.equal(draft.status, "draft");
  assert.equal(draft.source, "ai");

  // the assistant cannot write final notes or sign
  await request(app).post(`/api/patients/${pid}/notes`).set(AS_ASSISTANT("ai-draft")).send({ kind: "progress", body: "x" }).expect(403);
  await request(app).post(`/api/patients/${pid}/notes/${draft.id}/sign`).set(AS_ASSISTANT("ai-draft")).send({}).expect(403);

  // the clinician edits and signs; signing twice is refused
  const signed = (await request(app).post(`/api/patients/${pid}/notes/${draft.id}/sign`).set(CLIN)
    .send({ body: "Reviewed discharge summary" }).expect(200)).body;
  assert.equal(signed.status, "signed");
  assert.equal(signed.body, "Reviewed discharge summary");
  assert.equal(signed.signed_by, "clinician");
  await request(app).post(`/api/patients/${pid}/notes/${draft.id}/sign`).set(CLIN).send({}).expect(409);
});

test("AI interaction metadata is stored with the record (no content)", async () => {
  const { app, pid } = await setup();
  await request(app).post("/internal/ai-interactions").set(INTERNAL).send({
    patient_id: pid, actor: "clinician", feature: "summary", model: "claude-opus-5-5", outcome: "ok",
    input_tokens: 1200, output_tokens: 300, citations: 6,
  }).expect(201);
  await request(app).post("/internal/ai-interactions").set(INTERNAL).send({ patient_id: pid, question: "x" }).expect(422);
  const rec = (await request(app).get(`/api/patients/${pid}`).set(CLIN).expect(200)).body;
  assert.equal(rec.ai_interactions.length, 1);
  assert.equal(rec.ai_interactions[0].citations, 6);
});

test("dashboard is served with a strict CSP; readiness checks the database", async () => {
  const { app } = await setup();
  const res = await request(app).get("/").expect(200);
  assert.match(res.text, /CareSignal/);
  assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  await request(app).get("/readyz").expect(200);
  await request(app).get("/api/nothing").set(CLIN).expect(404);
});

// Found by the DAST scan (ZAP 10055): Express's own 404 page replaced the CSP with default-src 'none'
test("unknown paths answer 404 with the full security headers", async () => {
  const { app } = await setup();
  for (const path of ["/robots.txt", "/v1", "/api/nope"]) {
    const res = await request(app).get(path).expect(404);
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(res.headers["content-security-policy"], /form-action 'self'/);
  }
});
