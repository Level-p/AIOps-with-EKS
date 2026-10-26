// Client for records-api. The assistant has no database access of its own: it reads the record
// with the clinician's own credentials (so records-api decides access and audits it, with the
// purpose), plus the internal token that identifies the assistant.
class RecordsError extends Error {
  constructor(status) {
    super(`records-api answered ${status}`);
    this.name = "RecordsError";
    this.status = status;
  }
}

function recordsClient({ url, internalToken, timeoutMs = 5000 }) {
  async function call(method, path, { auth, purpose, body } = {}) {
    const headers = { accept: "application/json", "x-internal-token": internalToken };
    if (auth) headers.authorization = auth;
    if (purpose) headers["x-access-purpose"] = purpose;
    if (body) headers["content-type"] = "application/json";
    const res = await fetch(`${url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new RecordsError(res.status);
    return res.json();
  }
  // patientId is validated as a UUID by the caller, so it cannot change the path
  return {
    getRecord: (patientId, auth, purpose) => call("GET", `/api/patients/${patientId}`, { auth, purpose }),
    createDraft: (patientId, auth, draft) => call("POST", `/internal/patients/${patientId}/drafts`, { auth, purpose: "ai-draft", body: draft }),
    logInteraction: (interaction) => call("POST", "/internal/ai-interactions", { body: interaction }),
  };
}

module.exports = { recordsClient, RecordsError };
