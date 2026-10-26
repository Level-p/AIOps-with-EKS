const { Pool } = require("pg");
const { createApp } = require("./app");
const { createRepository, poolConfig } = require("./db");
const { createLogger, serve } = require("./common");

const log = createLogger("records-api");
const required = (name) => process.env[name] || (log.fatal({ variable: name }, "missing environment variable"), process.exit(1));

async function main() {
  const pool = new Pool(poolConfig());
  pool.on("error", (err) => log.error({ error: err.code || err.name }, "idle database connection failed"));
  const repo = createRepository(pool);
  // The database may still be starting (first deploy, failover): retry the schema for a minute
  for (let attempt = 1; ; attempt++) {
    try {
      await repo.migrate();
      break;
    } catch (err) {
      if (attempt >= 12) throw err;
      log.warn({ attempt, error: err.code || err.name }, "database not ready, retrying");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const app = createApp({ repo, clinicianToken: required("CLINICIAN_TOKEN"), internalToken: required("INTERNAL_TOKEN"), log });
  serve(app, { port: Number(process.env.PORT || 8080), log, onClose: () => pool.end() });
}

main().catch((err) => {
  log.fatal({ error: err.code || err.name }, "start-up failed");
  process.exit(1);
});
