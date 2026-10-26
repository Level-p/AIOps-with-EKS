// Test cases for the js-* rules in ai-code-rules.yml: `semgrep --test --config .semgrep/ai-code-rules.yml .semgrep/`
// "ruleid" lines must be reported, "ok" lines must not. Never executed.
const childProcess = require("child_process");
const crypto = require("node:crypto");
const { Anthropic } = require("@anthropic-ai/sdk");

function evalCases(input) {
  // ruleid: js-eval-new-function
  eval(input);
  // ruleid: js-eval-new-function
  const f = new Function("a", input);
  // ruleid: js-eval-new-function
  setTimeout("doSomething()", 10);
  // ok: js-eval-new-function
  setTimeout(() => f(), 10);
  // ok: js-eval-new-function
  return JSON.parse(input);
}

function shellCases(file) {
  // ruleid: js-child-process-shell
  childProcess.exec(`convert ${file} out.png`);
  // ruleid: js-child-process-shell
  require("child_process").execSync("ls " + file);
  // ruleid: js-child-process-shell
  childProcess.spawn("convert", [file], { shell: true });
  // ok: js-child-process-shell
  childProcess.execFile("convert", [file, "out.png"]);
}

async function sqlCases(pool, id, ward) {
  // ruleid: js-sql-built-with-strings
  await pool.query(`SELECT * FROM patients WHERE id = '${id}'`);
  // ruleid: js-sql-built-with-strings
  await pool.query("SELECT * FROM patients WHERE ward = '" + ward + "'");
  // ok: js-sql-built-with-strings
  await pool.query("SELECT * FROM patients WHERE id = $1", [id]);
}

function tlsCases() {
  // ruleid: js-tls-verification-disabled
  const ssl = { rejectUnauthorized: false };
  // ruleid: js-tls-verification-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  // ok: js-tls-verification-disabled
  const verified = { rejectUnauthorized: true, ca: process.env.DB_CA };
  return [ssl, verified];
}

function tokenCases(given, expectedToken) {
  // ruleid: js-secret-compared-with-equals
  if (given === expectedToken) return true;
  // ok: js-secret-compared-with-equals
  if (expectedToken === undefined) return false;
  // ok: js-secret-compared-with-equals
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expectedToken));
}

function htmlCases(el, answer) {
  // ruleid: js-html-injection-sink
  el.innerHTML = answer;
  // ruleid: js-html-injection-sink
  el.insertAdjacentHTML("beforeend", answer);
  // ok: js-html-injection-sink
  el.textContent = answer;
}

function logCases(log, patient, question) {
  // ruleid: js-phi-in-logs
  log.info({ pseudonym: patient.pseudonym }, "opened record");
  // ruleid: js-phi-in-logs
  log.warn({ question }, "question refused");
  // ok: js-phi-in-logs
  log.info({ patient_id: patient.id }, "opened record");
}

async function llmCases(client, pool) {
  const res = await client.messages.create({ model: "claude-opus-5-5", max_tokens: 100, messages: [] });
  const text = res.content[0].text;
  // ruleid: js-eval-new-function, js-llm-output-executed
  eval(text);
  // ruleid: js-llm-output-executed
  await fetch(text);
  // ruleid: js-llm-output-executed
  await pool.query(text);
  // ok: js-llm-output-executed
  console.log(text.length);
}

// ruleid: js-llm-api-key-in-code
const hardcoded = new Anthropic({ apiKey: "sk-ant-api03-example" });
// ok: js-llm-api-key-in-code
const fromEnv = new Anthropic();

module.exports = { evalCases, shellCases, sqlCases, tlsCases, tokenCases, htmlCases, logCases, llmCases, hardcoded, fromEnv };
