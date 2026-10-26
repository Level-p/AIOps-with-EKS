const { createApp, recordsApiStore } = require("./app");
const { createLogger, serve } = require("./common");

const log = createLogger("vitals-ingest");
const required = (name) => process.env[name] || (log.fatal({ variable: name }, "missing environment variable"), process.exit(1));

const app = createApp({
  deviceToken: required("DEVICE_TOKEN"),
  store: recordsApiStore({ url: process.env.RECORDS_API_URL || "http://records-api:8080", internalToken: required("INTERNAL_TOKEN") }),
  log,
});
serve(app, { port: Number(process.env.PORT || 8080), log });
