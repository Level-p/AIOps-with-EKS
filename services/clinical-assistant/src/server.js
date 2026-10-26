const { Anthropic } = require("@anthropic-ai/sdk");
const { createApp } = require("./app");
const { createLlm, TokenBudget, CircuitBreaker } = require("./llm");
const { recordsClient } = require("./records");
const { createLogger, serve } = require("./common");

const log = createLogger("clinical-assistant");
const required = (name) => process.env[name] || (log.fatal({ variable: name }, "missing environment variable"), process.exit(1));

// No API key: the assistant still runs, with the deterministic summary and safety flags only
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 90_000, maxRetries: 2 }) : null;
if (!client) log.warn("ANTHROPIC_API_KEY not set: AI features disabled, rule-based fallback only");

const llm = createLlm({
  client,
  model: process.env.LLM_MODEL || "claude-opus-5-5",
  maxTokens: Number(process.env.LLM_MAX_TOKENS || 8000),
  effort: process.env.LLM_EFFORT || "medium",
  budget: new TokenBudget(Number(process.env.LLM_DAILY_TOKEN_BUDGET || 2_000_000)),
  breaker: new CircuitBreaker({ threshold: 5, coolDownMs: 60_000 }),
});

const app = createApp({
  records: recordsClient({ url: process.env.RECORDS_API_URL || "http://records-api:8080", internalToken: required("INTERNAL_TOKEN") }),
  llm,
  clinicianToken: required("CLINICIAN_TOKEN"),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || 20),
  log,
});
serve(app, { port: Number(process.env.PORT || 8080), log });
