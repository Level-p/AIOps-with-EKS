// Small pieces every CareSignal service shares: JSON logger, constant-time token
// comparison, security headers, and the HTTP server lifecycle.
const crypto = require("node:crypto");
const helmet = require("helmet");
const pino = require("pino");

// One JSON object per line: time, level, service, message, trace_id, span_id (pino
// instrumentation), plus fields. Opaque ids only: never names, notes, questions or tokens.
function createLogger(service) {
  return pino({
    base: { service },
    messageKey: "message",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ["authorization", "token", "question", "body", "*.authorization", "*.token", "*.question", "*.body"],
      censor: "[redacted]",
    },
  });
}

// Hashing first gives equal-length buffers, so the comparison time says nothing about the token
function safeEqual(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !given || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const [scheme, token] = (req.get("authorization") || "").split(" ");
  return scheme === "Bearer" && token ? token.trim() : "";
}

// Strict headers for APIs and the dashboard: scripts and styles only from this origin,
// no framing, no referrer, nothing cached (patient data).
const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"],
    },
  },
  referrerPolicy: { policy: "no-referrer" },
});

function noStore(_req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

// Unknown routes: answer here, so the 404 keeps the headers above. Express's built-in 404 page
// replaces them with its own "Content-Security-Policy: default-src 'none'" (no frame-ancestors,
// no form-action), a finding of the DAST scan (ZAP rule 10055).
function notFound(_req, res) {
  res.status(404).json({ error: "not found" });
}

// Errors: log the type, answer without details (no stack traces or SQL to the client)
function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
      return res.status(err.status || 400).json({ error: "invalid request body" });
    }
    log.error({ err: { type: err.name, code: err.code }, route: req.route?.path }, "request failed");
    res.status(500).json({ error: "internal error" });
  };
}

// Graceful shutdown: Kubernetes sends SIGTERM, the pod leaves the Service endpoints, we finish
// in-flight requests, flush telemetry, then exit.
function serve(app, { port, log, onClose = async () => {} }) {
  const telemetry = require("./telemetry");
  const server = app.listen(port, () => log.info({ port }, "listening"));
  server.keepAliveTimeout = 65_000; // longer than the ALB idle timeout (60 s)
  const stop = () => {
    log.info("shutting down");
    server.close(async () => {
      await onClose().catch(() => {});
      await telemetry.shutdown().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 20_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

module.exports = { createLogger, safeEqual, bearer, securityHeaders, noStore, notFound, errorHandler, serve };
