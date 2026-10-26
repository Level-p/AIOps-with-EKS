// Guardrails around the model (OWASP Top 10 for LLM applications 2025):
//
//   LLM01 prompt injection     questions with injection patterns are refused; record text is
//                              escaped and fenced as data; the model has no tools to misuse
//   LLM02 sensitive disclosure minimum necessary context: no pseudonym, identifiers redacted
//                              from free text, only this patient's record, bounded size
//   LLM05 improper output      output validated by schema, links and identifiers removed,
//                              rendered as text (never HTML) by the dashboard
//   LLM06 excessive agency     the assistant can only write drafts; a clinician signs
//   LLM09 misinformation       every statement must cite record items; citations are checked
//                              against the record; ungrounded answers are withheld
//   LLM10 unbounded consumption  rate limit per clinician, daily token budget, circuit breaker

const MAX_QUESTION = 500;
const MAX_NOTE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 60_000;

// Identifier patterns that must never reach the model or leave it (synthetic data, but defence in depth)
const IDENTIFIERS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\b(?:\+?44\s?|0)\d{3,4}[\s-]?\d{3}[\s-]?\d{3,4}\b/g, "[phone]"],
  [/\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g, "[id-number]"], // NHS number shape (and US phone numbers)
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[id-number]"], // SSN shape
  [/\b(?:MRN|NHS|hospital number|patient id)\s*[:#]?\s*[A-Z0-9-]{4,}\b/gi, "[id-number]"],
  [/\b(?:DOB|date of birth|born)\s*[:]?\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/gi, "[date-of-birth]"],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g, "[postcode]"],
];

const INJECTION = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules|guidelines|above|previous)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\s+to\s+be\b|\bjailbreak\b/i,
  /<\/?\s*(record|system|instructions?|assistant|user)\s*>/i,
  /\b(reveal|print|show|repeat|leak)\b.{0,40}\b(prompt|instructions|configuration|api key|token|secret)s?\b/i,
  /\b(api[\s_-]?keys?|passwords?|secrets?|access tokens?|credentials)\b/i,
  /\b(all|other|every|another)\s+patients?'?\b.{0,40}\b(records?|names?|data|list)\b|\blist\s+(all\s+)?patients\b/i,
];

function redact(text, { pseudonym } = {}) {
  let out = String(text ?? "");
  if (pseudonym) out = out.split(pseudonym).join("[patient]");
  for (const [re, label] of IDENTIFIERS) out = out.replace(re, label);
  return out;
}

const looksLikeInjection = (text) => INJECTION.some((re) => re.test(String(text ?? "")));

// Record text is data: it cannot open or close our <record> fence or add markup
const escapeData = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

// Question from a clinician: refuse clear injection or scope attempts before any model call
function checkQuestion(question) {
  if (typeof question !== "string") return { ok: false, reason: "invalid" };
  const q = question.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (q.length < 3) return { ok: false, reason: "invalid" };
  if (q.length > MAX_QUESTION) return { ok: false, reason: "too_long" };
  if (looksLikeInjection(q)) return { ok: false, reason: "prompt_injection" };
  return { ok: true, question: redact(q) };
}

const fmtTime = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + "Z" : "unknown time");

// The record as the model sees it. Each item gets a short citation id (V1, M2, N3...) that maps
// back to the database row; the model must cite those ids, and only those.
function buildContext(record) {
  const { patient } = record;
  const index = new Map();
  const lines = [];
  let suspicious = 0;
  const add = (prefix, n, row, type, textLine) => {
    const cid = `${prefix}${n + 1}`;
    index.set(cid, { type, id: row.id });
    lines.push(`[${cid}] ${textLine}`);
  };
  const clean = (s, limit = 300) => {
    const red = redact(s, patient).replace(CONTROL, "");
    if (looksLikeInjection(red)) suspicious += 1;
    return escapeData(red.length > limit ? `${red.slice(0, limit)}…` : red);
  };

  lines.push(`PATIENT: age band ${patient.age_band}, sex ${patient.sex}, ward ${clean(patient.ward, 32)}`);
  if (patient.latest_score !== null && patient.latest_score !== undefined) {
    lines.push(`LATEST EARLY WARNING SCORE (NEWS2): ${patient.latest_score} (${patient.latest_risk}) at ${fmtTime(patient.latest_reading_at)}`);
  }
  lines.push("", "VITAL SIGNS (newest first):");
  record.readings.slice(0, 20).forEach((r, n) => add("V", n, r, "reading",
    `${fmtTime(r.recorded_at)} HR ${r.heart_rate}/min, RR ${r.respiratory_rate}/min, SpO2 ${r.spo2}%, systolic BP ${r.systolic_bp} mmHg, temp ${Number(r.temperature).toFixed(1)} °C, NEWS2 ${r.score} (${r.risk})`));
  lines.push("", "MEDICATIONS:");
  record.medications.forEach((m, n) => add("M", n, m, "medication", `${clean(m.name)} ${clean(m.dose)} ${m.route} ${clean(m.frequency)} (${m.status})`));
  lines.push("", "ALLERGIES:");
  record.allergies.forEach((a, n) => add("A", n, a, "allergy", `${clean(a.substance)}: ${clean(a.reaction) || "reaction not recorded"} (${a.severity})`));
  lines.push("", "PROBLEMS:");
  record.problems.forEach((p, n) => add("P", n, p, "problem", `${clean(p.description)} (${p.status})`));
  lines.push("", "NOTES (newest first):");
  record.notes.slice(0, 20).forEach((note, n) => add("N", n, note, "note",
    `${fmtTime(note.created_at)} ${note.kind} note, ${note.status}${note.source === "ai" ? " (AI draft)" : ""}: ${clean(note.body, MAX_NOTE_CHARS)}`));

  let text = lines.join("\n");
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n[record truncated]`;
  return { text, index, suspicious, items: index.size };
}

// Keep only citations that exist in this record; report what was dropped
function checkCitations(cids, index) {
  const list = Array.isArray(cids) ? cids : [];
  const valid = [...new Set(list.map((c) => String(c).replace(/[[\]\s]/g, "").toUpperCase()))].filter((c) => index.has(c));
  return { valid, invalid: list.length - valid.length };
}

// Final hygiene on any model text shown to people or stored in a draft
function cleanOutput(text, limit = 2000) {
  let s = String(text ?? "").replace(CONTROL, "");
  s = s.replace(/\b(?:https?|ftp|file|javascript|data):\S+/gi, "[link removed]").replace(/\bwww\.\S+/gi, "[link removed]");
  s = redact(s);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

module.exports = { redact, looksLikeInjection, escapeData, checkQuestion, buildContext, checkCitations, cleanOutput, MAX_QUESTION };
