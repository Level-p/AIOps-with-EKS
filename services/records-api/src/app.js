// records-api: the patient record (system of record) and the clinicians' dashboard.
// The only service that touches the database.
//
//   GET  /                                   dashboard (static; the browser keeps the token in sessionStorage)
//   GET  /api/patients[?ward=]               ward list with the latest early-warning score       (clinician)
//   POST /api/patients                       register a patient (pseudonym, ward, age band, sex)  (clinician)
//   GET  /api/patients/:id                   the record: vitals, medications, allergies, problems,
//                                            notes, AI activity                                    (clinician)
//   POST /api/patients/:id/{medications,allergies,problems,notes}                                  (clinician)
//   POST /api/patients/:id/notes/:noteId/sign  a clinician reviews, edits and signs an AI draft    (clinician only)
//   GET  /api/patients/:id/audit             who accessed the record, when, for what purpose     (clinician)
//   POST /internal/readings                  scored reading from vitals-ingest                    (internal)
//   POST /internal/patients/:id/drafts       AI draft note from clinical-assistant      (internal + clinician)
//   POST /internal/ai-interactions           metadata of one AI request (no content)              (internal)
//   GET  /healthz, /readyz
//
// Every read or change of a record writes an audit event with its purpose
// (X-Access-Purpose: care | ai-summary | ai-question | ai-draft).
const path = require("node:path");
const express = require("express");
const { metrics, trace } = require("@opentelemetry/api");
const { z } = require("zod");
const { safeEqual, bearer, securityHeaders, noStore, notFound, errorHandler } = require("./common");

const meter = metrics.getMeter("caresignal.records-api");
const STORED = meter.createCounter("caresignal.readings.stored", { unit: "{reading}", description: "Readings stored, by risk" });
const AUDITED = meter.createCounter("caresignal.audit.events", { unit: "{event}", description: "Audit events written, by action and purpose" });
const SIGNED = meter.createCounter("caresignal.notes.signed", { unit: "{note}", description: "AI drafts signed by a clinician, by whether they were edited" });

const PURPOSES = ["care", "ai-summary", "ai-question", "ai-draft"];
const text = (min, max, re) => (re ? z.string().trim().min(min).max(max).regex(re) : z.string().trim().min(min).max(max));
const SAFE = /^[\p{L}\p{N} ._()%/+,'-]+$/u;

const PatientIn = z.strictObject({
  pseudonym: text(2, 64, /^[A-Za-z0-9 ._-]+$/),
  ward: text(1, 32, /^[A-Za-z0-9 ._-]+$/),
  age_band: z.enum(["0-17", "18-39", "40-64", "65-79", "80+"]).default("40-64"),
  sex: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
});
const MedicationIn = z.strictObject({
  name: text(2, 80, SAFE), dose: text(1, 40, SAFE),
  route: z.enum(["oral", "iv", "im", "sc", "inhaled", "topical", "other"]),
  frequency: text(1, 40, SAFE), status: z.enum(["active", "stopped"]).default("active"),
});
const AllergyIn = z.strictObject({
  substance: text(2, 80, SAFE), reaction: text(0, 120).default(""), severity: z.enum(["mild", "moderate", "severe"]),
});
const ProblemIn = z.strictObject({ description: text(2, 200), status: z.enum(["active", "resolved"]).default("active") });
const NoteIn = z.strictObject({ kind: z.enum(["progress", "admission", "nursing", "handover", "discharge"]), body: text(1, 8000) });
const DraftIn = z.strictObject({ kind: z.enum(["handover", "discharge"]), body: text(1, 12000), model: text(1, 64) });
const SignIn = z.strictObject({ body: text(1, 12000).optional() });
const ReadingIn = z.strictObject({
  patient_id: z.uuid(), device_id: text(3, 64),
  heart_rate: z.int(), respiratory_rate: z.int(), spo2: z.int(), systolic_bp: z.int(), temperature: z.number(),
  score: z.int().min(0).max(20), risk: z.enum(["low", "medium", "high"]), recorded_at: z.iso.datetime({ offset: true }),
});
const AiInteractionIn = z.strictObject({
  patient_id: z.uuid(), actor: text(1, 64), feature: z.enum(["summary", "question", "draft"]), model: text(1, 64),
  outcome: z.enum(["ok", "fallback", "blocked", "error", "refused", "ungrounded"]),
  input_tokens: z.int().min(0), output_tokens: z.int().min(0), citations: z.int().min(0),
});

function createApp({ repo, clinicianToken, internalToken, log }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: 0 }));
  app.use(noStore, express.json({ limit: "64kb" }));

  // ---- who is calling ----------------------------------------------------------------------
  const isInternal = (req) => safeEqual(req.get("x-internal-token"), internalToken);

  // Demo authentication: one bearer token for clinicians. Production: OIDC (Cognito/Entra ID) at
  // the load balancer or in the app, with one identity per clinician in the audit trail.
  function clinician(req, res, next) {
    if (!safeEqual(bearer(req), clinicianToken)) {
      return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorised" });
    }
    const purpose = req.get("x-access-purpose") || "care";
    if (!PURPOSES.includes(purpose)) return res.status(400).json({ error: "unknown access purpose" });
    // The assistant calls on behalf of the clinician: both credentials, recorded as such
    req.actor = isInternal(req) ? "clinician via clinical-assistant" : "clinician";
    if (purpose.startsWith("ai-") && req.actor === "clinician") return res.status(403).json({ error: "AI purposes are for the assistant" });
    req.purpose = purpose;
    next();
  }
  function internal(req, res, next) {
    if (!isInternal(req)) return res.status(401).json({ error: "unauthorised" });
    next();
  }

  const audit = async (req, action, patientId) => {
    await repo.audit(req.actor || "service", action, req.purpose || "care", patientId);
    AUDITED.add(1, { action, purpose: req.purpose || "care" });
  };
  const body = (schema, req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "invalid request", fields: parsed.error.issues.map((i) => i.path.join(".")) });
      return null;
    }
    return parsed.data;
  };
  // Path ids must be UUIDs (anything else is simply "not found", never reaches SQL)
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  async function patient(req, res, next) {
    if (!UUID.test(req.params.id) || (req.params.noteId && !UUID.test(req.params.noteId))) return res.status(404).json({ error: "patient not found" });
    req.patient = await repo.getPatient(req.params.id);
    if (!req.patient) return res.status(404).json({ error: "patient not found" });
    trace.getActiveSpan()?.setAttribute("caresignal.patient_id", req.params.id); // opaque id only
    next();
  }

  // ---- probes ------------------------------------------------------------------------------
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    try {
      await repo.ping();
      res.json({ status: "ready" });
    } catch (err) {
      log.error({ error: err.code || err.name }, "database not reachable");
      res.status(503).json({ status: "database unavailable" });
    }
  });

  // ---- clinician API -----------------------------------------------------------------------
  app.get("/api/patients", clinician, async (req, res) => {
    const ward = typeof req.query.ward === "string" && /^[A-Za-z0-9 ._-]{1,32}$/.test(req.query.ward) ? req.query.ward : null;
    const patients = await repo.listPatients(ward);
    await audit(req, "list", null);
    res.json({ patients });
  });

  app.post("/api/patients", clinician, async (req, res) => {
    const data = body(PatientIn, req, res);
    if (!data) return;
    const p = await repo.createPatient(data);
    await audit(req, "create", p.id);
    res.status(201).json(p);
  });

  app.get("/api/patients/:id", clinician, patient, async (req, res) => {
    const record = await repo.getRecord(req.params.id);
    await audit(req, "read", req.params.id);
    res.json(record);
  });

  app.get("/api/patients/:id/audit", clinician, patient, async (req, res) => {
    res.json({ events: await repo.auditTrail(req.params.id) });
  });

  for (const [segment, schema, add, action] of [
    ["medications", MedicationIn, "addMedication", "add-medication"],
    ["allergies", AllergyIn, "addAllergy", "add-allergy"],
    ["problems", ProblemIn, "addProblem", "add-problem"],
  ]) {
    app.post(`/api/patients/:id/${segment}`, clinician, patient, async (req, res) => {
      const data = body(schema, req, res);
      if (!data) return;
      const row = await repo[add](req.params.id, data);
      await audit(req, action, req.params.id);
      res.status(201).json(row);
    });
  }

  // A clinician's own note is final at once
  app.post("/api/patients/:id/notes", clinician, patient, async (req, res) => {
    if (req.actor !== "clinician") return res.status(403).json({ error: "the assistant can only create drafts" });
    const data = body(NoteIn, req, res);
    if (!data) return;
    const note = await repo.addNote(req.params.id, { ...data, status: "final", source: "clinician", author: req.actor });
    await audit(req, "add-note", req.params.id);
    res.status(201).json(note);
  });

  // Human in the loop: only a clinician, never the assistant, turns an AI draft into a signed note
  app.post("/api/patients/:id/notes/:noteId/sign", clinician, patient, async (req, res) => {
    if (req.actor !== "clinician" || req.get("x-internal-token")) return res.status(403).json({ error: "only a clinician can sign" });
    const data = body(SignIn, req, res);
    if (!data) return;
    const draft = await repo.getNote(req.params.id, req.params.noteId);
    if (!draft) return res.status(404).json({ error: "note not found" });
    if (draft.status !== "draft") return res.status(409).json({ error: "only drafts can be signed" });
    const signed = await repo.signNote(req.params.id, req.params.noteId, { body: data.body ?? draft.body, signedBy: req.actor });
    if (!signed) return res.status(409).json({ error: "already signed" });
    SIGNED.add(1, { edited: String(data.body !== undefined && data.body !== draft.body) });
    await audit(req, "sign-note", req.params.id);
    res.json(signed);
  });

  // ---- service-to-service ------------------------------------------------------------------
  app.post("/internal/readings", internal, async (req, res) => {
    const data = body(ReadingIn, req, res);
    if (!data) return;
    if (!(await repo.getPatient(data.patient_id))) return res.status(404).json({ error: "unknown patient" });
    await repo.addReading(data);
    STORED.add(1, { risk: data.risk });
    res.status(201).json({ stored: true });
  });

  // The assistant writes drafts on behalf of the clinician who asked: both credentials are needed
  app.post("/internal/patients/:id/drafts", internal, clinician, patient, async (req, res) => {
    const data = body(DraftIn, req, res);
    if (!data) return;
    const note = await repo.addNote(req.params.id, {
      kind: data.kind, body: data.body, model: data.model, status: "draft", source: "ai", author: "clinical-assistant",
    });
    await audit(req, "ai-draft", req.params.id);
    res.status(201).json(note);
  });

  app.post("/internal/ai-interactions", internal, async (req, res) => {
    const data = body(AiInteractionIn, req, res);
    if (!data) return;
    if (!(await repo.getPatient(data.patient_id))) return res.status(404).json({ error: "unknown patient" });
    await repo.addAiInteraction(data);
    res.status(201).json({ recorded: true });
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

module.exports = { createApp };
