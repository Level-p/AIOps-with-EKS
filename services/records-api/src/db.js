// PostgreSQL access for the patient record. Bound parameters only ($1, $2...): no SQL is ever
// built from request data. The schema is created at start-up (idempotent).
//
// Only synthetic, pseudonymised data: a patient has an opaque id, a pseudonym
// ("Bed 12 - P-4471"), a ward, an age band and sex; no names, dates of birth or addresses.
const crypto = require("node:crypto");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY,
  pseudonym varchar(64) NOT NULL,
  ward varchar(32) NOT NULL,
  age_band varchar(8) NOT NULL,
  sex varchar(8) NOT NULL,
  latest_score integer,
  latest_risk varchar(8),
  latest_reading_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS patients_ward ON patients (ward);
CREATE TABLE IF NOT EXISTS readings (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  device_id varchar(64) NOT NULL,
  heart_rate integer NOT NULL,
  respiratory_rate integer NOT NULL,
  spo2 integer NOT NULL,
  systolic_bp integer NOT NULL,
  temperature real NOT NULL,
  score integer NOT NULL,
  risk varchar(8) NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_patient_time ON readings (patient_id, recorded_at);
CREATE TABLE IF NOT EXISTS medications (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  dose varchar(40) NOT NULL,
  route varchar(16) NOT NULL,
  frequency varchar(40) NOT NULL,
  status varchar(8) NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS allergies (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  substance varchar(80) NOT NULL,
  reaction varchar(120) NOT NULL,
  severity varchar(8) NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS problems (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  description varchar(200) NOT NULL,
  status varchar(8) NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,
  body text NOT NULL,
  status varchar(8) NOT NULL,
  source varchar(16) NOT NULL,
  author varchar(64) NOT NULL,
  model varchar(64),
  signed_by varchar(64),
  signed_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_patient_time ON notes (patient_id, created_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  actor varchar(64) NOT NULL,
  action varchar(32) NOT NULL,
  purpose varchar(16) NOT NULL,
  patient_id uuid,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_patient_time ON audit_events (patient_id, at);
CREATE TABLE IF NOT EXISTS ai_interactions (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  actor varchar(64) NOT NULL,
  feature varchar(16) NOT NULL,
  model varchar(64) NOT NULL,
  outcome varchar(16) NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  citations integer NOT NULL,
  at timestamptz NOT NULL
);
`;

const id = () => crypto.randomUUID();
const now = () => new Date();

function createRepository(pool) {
  const q = (text, values) => pool.query(text, values).then((r) => r.rows);

  return {
    async migrate() {
      await pool.query(SCHEMA);
    },
    async ping() {
      await pool.query("SELECT 1");
    },

    async listPatients(ward) {
      const cols = "id, pseudonym, ward, age_band, sex, latest_score, latest_risk, latest_reading_at";
      return ward
        ? q(`SELECT ${cols} FROM patients WHERE ward = $1 ORDER BY ward, pseudonym`, [ward])
        : q(`SELECT ${cols} FROM patients ORDER BY ward, pseudonym`);
    },
    async createPatient(p) {
      const row = { id: id(), ...p, created_at: now() };
      await q("INSERT INTO patients (id, pseudonym, ward, age_band, sex, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [row.id, row.pseudonym, row.ward, row.age_band, row.sex, row.created_at]);
      return row;
    },
    async getPatient(patientId) {
      const [p] = await q("SELECT * FROM patients WHERE id = $1", [patientId]);
      return p || null;
    },

    // The whole record, newest first, bounded (minimum necessary for one screen or one AI request)
    async getRecord(patientId) {
      const patient = await this.getPatient(patientId);
      if (!patient) return null;
      const [readings, medications, allergies, problems, notes, ai] = await Promise.all([
        q("SELECT * FROM readings WHERE patient_id = $1 ORDER BY recorded_at DESC LIMIT 50", [patientId]),
        q("SELECT * FROM medications WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 100", [patientId]),
        q("SELECT * FROM allergies WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 50", [patientId]),
        q("SELECT * FROM problems WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 50", [patientId]),
        q("SELECT * FROM notes WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 50", [patientId]),
        q("SELECT * FROM ai_interactions WHERE patient_id = $1 ORDER BY at DESC LIMIT 20", [patientId]),
      ]);
      return { patient, readings, medications, allergies, problems, notes, ai_interactions: ai };
    },

    async addReading(r) {
      await q(`INSERT INTO readings (id, patient_id, device_id, heart_rate, respiratory_rate, spo2, systolic_bp, temperature,
                 score, risk, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id(), r.patient_id, r.device_id, r.heart_rate, r.respiratory_rate, r.spo2, r.systolic_bp, r.temperature,
          r.score, r.risk, new Date(r.recorded_at)]);
      // Denormalised latest score for the ward list (a late, older reading does not overwrite a newer one)
      await q(`UPDATE patients SET latest_score = $2, latest_risk = $3, latest_reading_at = $4
               WHERE id = $1 AND (latest_reading_at IS NULL OR latest_reading_at <= $4)`,
        [r.patient_id, r.score, r.risk, new Date(r.recorded_at)]);
    },

    async addMedication(patientId, m) {
      const row = { id: id(), patient_id: patientId, ...m, created_at: now() };
      await q("INSERT INTO medications (id, patient_id, name, dose, route, frequency, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [row.id, patientId, m.name, m.dose, m.route, m.frequency, m.status, row.created_at]);
      return row;
    },
    async addAllergy(patientId, a) {
      const row = { id: id(), patient_id: patientId, ...a, created_at: now() };
      await q("INSERT INTO allergies (id, patient_id, substance, reaction, severity, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [row.id, patientId, a.substance, a.reaction, a.severity, row.created_at]);
      return row;
    },
    async addProblem(patientId, p) {
      const row = { id: id(), patient_id: patientId, ...p, created_at: now() };
      await q("INSERT INTO problems (id, patient_id, description, status, created_at) VALUES ($1, $2, $3, $4, $5)",
        [row.id, patientId, p.description, p.status, row.created_at]);
      return row;
    },

    async addNote(patientId, n) {
      const row = { id: id(), patient_id: patientId, signed_by: null, signed_at: null, model: null, ...n, created_at: now() };
      await q(`INSERT INTO notes (id, patient_id, kind, body, status, source, author, model, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row.id, patientId, row.kind, row.body, row.status, row.source, row.author, row.model, row.created_at]);
      return row;
    },
    async getNote(patientId, noteId) {
      const [n] = await q("SELECT * FROM notes WHERE id = $1 AND patient_id = $2", [noteId, patientId]);
      return n || null;
    },
    // Only a draft can be signed; the WHERE clause makes it atomic (two clicks sign once)
    async signNote(patientId, noteId, { body, signedBy }) {
      const at = now();
      const rows = await q(`UPDATE notes SET status = 'signed', body = $3, signed_by = $4, signed_at = $5
                            WHERE id = $1 AND patient_id = $2 AND status = 'draft' RETURNING *`,
        [noteId, patientId, body, signedBy, at]);
      return rows[0] || null;
    },

    async audit(actor, action, purpose, patientId = null) {
      await q("INSERT INTO audit_events (id, actor, action, purpose, patient_id, at) VALUES ($1, $2, $3, $4, $5, $6)",
        [id(), actor, action, purpose, patientId, now()]);
    },
    async auditTrail(patientId) {
      return q("SELECT actor, action, purpose, at FROM audit_events WHERE patient_id = $1 ORDER BY at DESC LIMIT 100", [patientId]);
    },

    async addAiInteraction(i) {
      await q(`INSERT INTO ai_interactions (id, patient_id, actor, feature, model, outcome, input_tokens, output_tokens, citations, at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id(), i.patient_id, i.actor, i.feature, i.model, i.outcome, i.input_tokens, i.output_tokens, i.citations, now()]);
    },
  };
}

// DB_SSLMODE=require (default): encrypted, server certificate not verified, because the
// postgres-operator's default certificate is self-signed (same as libpq sslmode=require).
// verify-full: verified against DB_CA (mount the cluster CA in production). disable: tests only.
function sslConfig(env) {
  if (env.DB_SSLMODE === "disable") return false;
  if (env.DB_SSLMODE === "verify-full") return { ca: env.DB_CA, rejectUnauthorized: true };
  // nosemgrep: js-tls-verification-disabled -- reviewed: encryption-only mode, see above
  return { rejectUnauthorized: false };
}

// Connection settings from the postgres-operator's secret (DB_USER/DB_PASSWORD) and the chart
function poolConfig(env = process.env) {
  return {
    host: env.DB_HOST || "caresignal-db",
    port: 5432,
    database: env.DB_NAME || "caresignal",
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: sslConfig(env),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  };
}

module.exports = { createRepository, poolConfig, SCHEMA };
