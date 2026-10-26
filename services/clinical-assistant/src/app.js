// clinical-assistant: the LLM features of CareSignal, over one patient record at a time.
//
//   POST /api/assistant/patients/:id/summary   grounded summary + deterministic safety flags
//   POST /api/assistant/patients/:id/ask       {question} -> answer with citations, or "not in the record"
//   POST /api/assistant/patients/:id/draft     {kind: discharge|handover} -> DRAFT note in the record;
//                                               a clinician reviews, edits and signs it in records-api
//   GET  /healthz, /readyz
//
// Flow of every request: clinician token -> rate limit -> question guard -> record from
// records-api (clinician's credentials, purpose audited) -> minimum-necessary context ->
// Claude (structured output) -> citation check -> output hygiene -> response + AI-interaction
// metadata in the record. Model unavailable -> deterministic fallback, never a guess.
const crypto = require("node:crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { bearer, safeEqual, securityHeaders, noStore, notFound, errorHandler } = require("./common");
const { buildContext, checkCitations, checkQuestion, cleanOutput } = require("./guardrails");
const { safetyFlags, ruleSummary } = require("./fallback");
const { Unavailable } = require("./llm");
const { RecordsError } = require("./records");
const { REQUESTS, BLOCKS, INJECTION_SUSPECTED, GROUNDING_FAILURES, SAFETY_FLAGS } = require("./metrics");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCLAIMER = "AI-generated from this patient's record only. Decision support for clinicians: verify against the record before acting.";
const DraftIn = z.strictObject({ kind: z.enum(["discharge", "handover"]) });
const AskIn = z.strictObject({ question: z.string() });

function createApp({ records, llm, clinicianToken, log, rateLimitPerMinute = 20, clock = () => new Date() }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders, noStore, express.json({ limit: "4kb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // Ready even without a model: the deterministic features still work, and the state is visible
  app.get("/readyz", (_req, res) => res.json({ status: "ready", llm: llm.configured ? "configured" : "not configured" }));

  const api = express.Router();

  api.use((req, res, next) => {
    if (!safeEqual(bearer(req), clinicianToken)) return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorised" });
    next();
  });
  // LLM10: per clinician credential, in this pod (keyed by a hash, never the token itself)
  api.use(rateLimit({
    windowMs: 60_000,
    limit: rateLimitPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => crypto.createHash("sha256").update(bearer(req)).digest("hex"),
    handler: (_req, res) => {
      BLOCKS.add(1, { reason: "rate_limited" });
      res.status(429).json({ error: "too many assistant requests, try again in a minute" });
    },
  }));
  api.param("id", (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: "patient not found" })));

  // Helpers -------------------------------------------------------------------------------
  const loadRecord = async (req, res, purpose) => {
    try {
      const record = await records.getRecord(req.params.id, req.get("authorization"), purpose);
      if (!record) res.status(404).json({ error: "patient not found" });
      return record;
    } catch (err) {
      if (err instanceof RecordsError && err.status === 401) res.status(401).json({ error: "unauthorised" });
      else res.status(502).json({ error: "patient record unavailable" });
      return null;
    }
  };
  const context = (record) => {
    const ctx = buildContext(record);
    if (ctx.suspicious) {
      INJECTION_SUSPECTED.add(ctx.suspicious);
      log.warn({ patient_id: record.patient.id, items: ctx.suspicious }, "record text looks like a prompt injection (sent as data)");
    }
    return ctx;
  };
  const cite = (cids, index) => cids.map((cid) => ({ id: cid, type: index.get(cid).type, record_id: index.get(cid).id }));
  // Metadata only (feature, outcome, tokens, number of citations): never the question or answer
  const recordInteraction = (patientId, feature, outcome, result, citations = 0) => {
    records.logInteraction({
      patient_id: patientId, actor: "clinician", feature, outcome, citations,
      model: result?.model || llm.model, input_tokens: result?.usage.input || 0, output_tokens: result?.usage.output || 0,
    }).catch((err) => log.warn({ error: err.name }, "could not record AI interaction"));
  };
  const outcomeOf = (err) => (err instanceof Unavailable ? (err.reason === "refused" ? "refused" : "fallback") : "error");
  const failed = (feature, err) => {
    log.warn({ feature, reason: err.reason || err.name, status: err.status }, "model call did not produce an answer");
    return err.reason || "provider_error";
  };

  // Summary -------------------------------------------------------------------------------
  api.post("/patients/:id/summary", async (req, res) => {
    const record = await loadRecord(req, res, "ai-summary");
    if (!record) return;
    const ctx = context(record);
    const flags = safetyFlags(record, ctx.index);
    for (const f of flags) SAFETY_FLAGS.add(1, { type: f.type });

    const fallback = (reason, outcome) => {
      REQUESTS.add(1, { feature: "summary", outcome });
      recordInteraction(record.patient.id, "summary", outcome, null);
      const s = ruleSummary(record, ctx.index);
      return res.json({
        ai_generated: false, fallback_reason: reason, overview: s.overview,
        findings: s.findings.map((f) => ({ ...f, citations: cite(f.citations, ctx.index) })),
        gaps: [], confidence: s.confidence, safety_flags: flags.map((f) => ({ ...f, citations: cite(f.citations, ctx.index) })),
      });
    };

    let result;
    try {
      result = await llm.summarize(ctx.text);
    } catch (err) {
      return fallback(failed("summary", err), outcomeOf(err));
    }
    const out = result.output;
    const findings = [];
    let dropped = 0;
    for (const f of out.findings.slice(0, 12)) {
      const { valid } = checkCitations(f.citations, ctx.index);
      if (valid.length) findings.push({ category: f.category, text: cleanOutput(f.text, 400), citations: cite(valid, ctx.index) });
      else dropped += 1;
    }
    const overview = checkCitations(out.overview.citations, ctx.index);
    if (dropped) GROUNDING_FAILURES.add(dropped, { feature: "summary" });
    // Mostly ungrounded output is not shown at all
    if (out.findings.length && dropped > out.findings.length / 2) return fallback("ungrounded", "ungrounded");

    const citations = findings.reduce((n, f) => n + f.citations.length, 0) + overview.valid.length;
    REQUESTS.add(1, { feature: "summary", outcome: "ok" });
    recordInteraction(record.patient.id, "summary", "ok", result, citations);
    res.json({
      ai_generated: true, model: result.model, disclaimer: DISCLAIMER,
      overview: { text: cleanOutput(out.overview.text, 800), citations: cite(overview.valid, ctx.index) },
      findings, dropped_ungrounded: dropped,
      gaps: out.gaps.slice(0, 8).map((g) => cleanOutput(g, 200)),
      confidence: out.confidence,
      safety_flags: flags.map((f) => ({ ...f, citations: cite(f.citations, ctx.index) })),
    });
  });

  // Question ------------------------------------------------------------------------------
  api.post("/patients/:id/ask", async (req, res) => {
    const parsed = AskIn.safeParse(req.body);
    const check = parsed.success ? checkQuestion(parsed.data.question) : { ok: false, reason: "invalid" };
    if (!check.ok) {
      BLOCKS.add(1, { reason: check.reason });
      REQUESTS.add(1, { feature: "question", outcome: "blocked" });
      log.warn({ patient_id: req.params.id, reason: check.reason }, "question refused by guardrail");
      const message = check.reason === "prompt_injection"
        ? "This question cannot be answered: ask about this patient's record only."
        : check.reason === "too_long" ? "The question is too long (500 characters at most)." : "Invalid question.";
      return res.status(400).json({ error: message, reason: check.reason });
    }
    const record = await loadRecord(req, res, "ai-question");
    if (!record) return;
    const ctx = context(record);

    let result;
    try {
      result = await llm.answer(ctx.text, check.question.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    } catch (err) {
      const outcome = outcomeOf(err);
      REQUESTS.add(1, { feature: "question", outcome });
      recordInteraction(record.patient.id, "question", outcome, null);
      return res.status(503).json({ error: "The assistant is not available right now; please use the record directly.", reason: failed("question", err) });
    }
    const out = result.output;
    const { valid } = checkCitations(out.citations, ctx.index);
    let answer = cleanOutput(out.answer, 1500);
    let grounded = valid.length > 0;
    let outcome = "ok";
    if (!grounded && !out.insufficient_information) {
      // An answer that cites nothing in the record is withheld (LLM09)
      GROUNDING_FAILURES.add(1, { feature: "question" });
      answer = "The assistant could not support an answer with this patient's record. Please check the record directly.";
      outcome = "ungrounded";
    }
    if (out.insufficient_information) grounded = true; // "not in the record" is a grounded answer
    REQUESTS.add(1, { feature: "question", outcome });
    recordInteraction(record.patient.id, "question", outcome, result, valid.length);
    res.json({
      ai_generated: true, model: result.model, disclaimer: DISCLAIMER, answer, grounded,
      insufficient_information: out.insufficient_information, confidence: out.confidence, citations: cite(valid, ctx.index),
    });
  });

  // Draft note ----------------------------------------------------------------------------
  api.post("/patients/:id/draft", async (req, res) => {
    const parsed = DraftIn.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: "kind must be discharge or handover" });
    const record = await loadRecord(req, res, "ai-draft");
    if (!record) return;
    const ctx = context(record);

    let result;
    try {
      result = await llm.draft(ctx.text, parsed.data.kind);
    } catch (err) {
      const outcome = outcomeOf(err);
      REQUESTS.add(1, { feature: "draft", outcome });
      recordInteraction(record.patient.id, "draft", outcome, null);
      return res.status(503).json({ error: "The assistant is not available right now; no draft was created.", reason: failed("draft", err) });
    }
    let citations = 0;
    let unsupported = 0;
    const body = [
      `AI DRAFT (${parsed.data.kind}) - requires clinician review, editing and signature before use.`,
      `Generated by ${result.model} on ${clock().toISOString().slice(0, 16).replace("T", " ")} UTC from this patient's record. Citations in [ ] refer to record items.`,
      "",
      ...result.output.sections.slice(0, 10).flatMap((s) => {
        const { valid } = checkCitations(s.citations, ctx.index);
        citations += valid.length;
        const text = cleanOutput(s.text, 2000);
        // Sections that cite nothing are marked for the reviewer ("Not recorded" sections are fine)
        const mark = valid.length || /not recorded/i.test(text) ? "" : " [UNSUPPORTED: check against the record]";
        if (mark) unsupported += 1;
        return [`## ${cleanOutput(s.heading, 80)}`, `${text}${valid.length ? ` [${valid.join(", ")}]` : ""}${mark}`, ""];
      }),
    ].join("\n");
    if (unsupported) GROUNDING_FAILURES.add(unsupported, { feature: "draft" });

    let note;
    try {
      note = await records.createDraft(req.params.id, req.get("authorization"), { kind: parsed.data.kind, body, model: result.model });
    } catch (err) {
      log.error({ error: err.name, status: err.status }, "could not save the draft");
      return res.status(502).json({ error: "The draft could not be saved in the record." });
    }
    REQUESTS.add(1, { feature: "draft", outcome: "ok" });
    recordInteraction(record.patient.id, "draft", "ok", result, citations);
    res.status(201).json({ ai_generated: true, model: result.model, disclaimer: DISCLAIMER, unsupported_sections: unsupported, note });
  });

  app.use("/api/assistant", api);
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

module.exports = { createApp, DISCLAIMER };
