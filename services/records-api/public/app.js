// CareSignal dashboard. Plain JavaScript under a strict CSP (scripts from this origin only).
// Every value from the API, and above all every piece of model output, is put on the page with
// textContent, never innerHTML: record text or an AI answer cannot become markup or script.
"use strict";

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("caresignal-token") || "";
let current = null; // patient id on screen

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 401) {
    signOut();
    throw new Error("Signed out: the token was not accepted.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status, body });
  return body;
}

const time = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "");
const badge = (risk, score) => el("span", { class: `badge ${risk || "none"}` }, risk ? `${score ?? ""} ${risk}` : "no data");

// ---- sign in -----------------------------------------------------------------------------
function signOut() {
  token = "";
  sessionStorage.removeItem("caresignal-token");
  $("main").hidden = true;
  $("login").hidden = false;
  $("who").replaceChildren();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  sessionStorage.setItem("caresignal-token", token);
  $("token").value = "";
  await start();
});

async function start() {
  if (!token) return signOut();
  try {
    await loadPatients();
    $("login").hidden = true;
    $("main").hidden = false;
    $("who").replaceChildren(el("span", {}, "Clinician "), el("button", { class: "link", onclick: signOut }, "Sign out"));
  } catch {
    signOut();
  }
}

// ---- ward list ---------------------------------------------------------------------------
async function loadPatients() {
  const ward = $("ward-filter").value;
  const { patients } = await api(`/api/patients${ward ? `?ward=${encodeURIComponent(ward)}` : ""}`);
  const wards = new Set([...$("ward-filter").options].map((o) => o.value));
  for (const p of patients) if (!wards.has(p.ward)) { $("ward-filter").append(el("option", { value: p.ward }, p.ward)); wards.add(p.ward); }
  $("patients").replaceChildren(...patients.map((p) => el("li", { class: p.id === current ? "active" : "", onclick: () => openPatient(p.id) },
    el("span", {}, `${p.pseudonym} `, el("small", {}, p.ward)), badge(p.latest_risk, p.latest_score))));
}
$("ward-filter").addEventListener("change", loadPatients);

$("new-patient").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  try {
    const p = await api("/api/patients", { method: "POST", body: JSON.stringify(form) });
    e.target.reset();
    await loadPatients();
    await openPatient(p.id);
  } catch (err) {
    alert(err.message);
  }
});

// ---- record ------------------------------------------------------------------------------
async function openPatient(id) {
  current = id;
  const r = await api(`/api/patients/${id}`);
  $("record-empty").hidden = true;
  $("record-body").hidden = false;
  $("p-title").textContent = r.patient.pseudonym;
  $("p-risk").replaceWith(Object.assign(badge(r.patient.latest_risk, r.patient.latest_score), { id: "p-risk" }));
  $("p-meta").textContent = `Ward ${r.patient.ward} · age ${r.patient.age_band} · ${r.patient.sex}`;
  $("vitals").replaceChildren(...r.readings.slice(0, 12).map((v) => el("tr", { dataset: { recordId: v.id } },
    el("td", {}, time(v.recorded_at)), el("td", {}, v.heart_rate), el("td", {}, v.respiratory_rate), el("td", {}, `${v.spo2}%`),
    el("td", {}, v.systolic_bp), el("td", {}, Number(v.temperature).toFixed(1)), el("td", {}, badge(v.risk, v.score)))));
  const item = (row, text) => el("li", { dataset: { recordId: row.id } }, text);
  $("meds").replaceChildren(...r.medications.map((m) => item(m, `${m.name} ${m.dose} ${m.route} ${m.frequency} (${m.status})`)));
  $("allergies").replaceChildren(...r.allergies.map((a) => item(a, `${a.substance}: ${a.reaction || "reaction not recorded"} (${a.severity})`)));
  $("problems").replaceChildren(...r.problems.map((p) => item(p, `${p.description} (${p.status})`)));
  $("notes").replaceChildren(...r.notes.map(noteItem));
  $("ai-activity").replaceChildren(...r.ai_interactions.map((i) =>
    el("li", {}, `${time(i.at)} · ${i.feature} · ${i.outcome} · ${i.citations} citation(s) · ${i.input_tokens + i.output_tokens} tokens`)));
  for (const b of ["btn-summary", "btn-handover", "btn-discharge", "btn-ask", "question"]) $(b).disabled = false;
  $("ai-output").replaceChildren();
  $("ai-status").textContent = "";
  await loadPatients();
}

function noteItem(n) {
  const head = el("div", { class: "row" },
    el("strong", {}, `${n.kind} · ${time(n.created_at)}`),
    el("span", { class: `badge ${n.status}` }, n.source === "ai" ? `AI ${n.status}` : n.status));
  const li = el("li", { dataset: { recordId: n.id } }, head);
  if (n.status === "draft") {
    // Human in the loop: the clinician reads, edits and signs; nothing is final before that
    const area = el("textarea", { rows: "10", "aria-label": "Draft text" });
    area.value = n.body;
    const sign = el("button", {
      onclick: async () => {
        sign.disabled = true;
        try {
          await api(`/api/patients/${current}/notes/${n.id}/sign`, { method: "POST", body: JSON.stringify({ body: area.value }) });
          await openPatient(current);
        } catch (err) {
          alert(err.message);
          sign.disabled = false;
        }
      },
    }, "I have reviewed this draft: sign");
    li.append(el("p", { class: "warn" }, "AI draft: review every statement against the record before signing."), area, sign);
  } else {
    li.append(el("p", { class: "pre" }, n.body));
    if (n.signed_at) li.append(el("small", {}, `Signed by ${n.signed_by} · ${time(n.signed_at)}`));
  }
  return li;
}

$("new-note").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/api/patients/${current}/notes`, { method: "POST", body: JSON.stringify(form) });
    e.target.reset();
    await openPatient(current);
  } catch (err) {
    alert(err.message);
  }
});

// ---- assistant ---------------------------------------------------------------------------
function citations(list) {
  return el("span", { class: "cites" }, ...(list || []).map((c) =>
    el("button", { class: "cite", title: `Show ${c.type}`, onclick: () => highlight(c.record_id) }, c.id)));
}

function highlight(recordId) {
  const target = document.querySelector(`[data-record-id="${CSS.escape(recordId)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1600);
}

async function assistant(label, path, body) {
  $("ai-status").textContent = `${label}…`;
  $("ai-output").replaceChildren();
  try {
    const res = await api(`/api/assistant/patients/${current}/${path}`, { method: "POST", body: JSON.stringify(body || {}) });
    $("ai-status").textContent = res.ai_generated ? `${res.model} · ${res.disclaimer}` : `Rule-based summary (AI not available: ${res.fallback_reason})`;
    return res;
  } catch (err) {
    $("ai-status").textContent = err.message;
    return null;
  }
}

$("btn-summary").addEventListener("click", async () => {
  const res = await assistant("Summarising", "summary");
  if (!res) return;
  const out = [];
  for (const f of res.safety_flags) out.push(el("p", { class: "flag" }, "Safety check: ", f.text, " ", citations(f.citations)));
  out.push(el("p", {}, res.overview.text, " ", citations(res.overview.citations)));
  out.push(el("ul", { class: "list small" }, ...res.findings.map((f) => el("li", {}, el("em", {}, `${f.category}: `), f.text, " ", citations(f.citations)))));
  if (res.gaps?.length) out.push(el("p", { class: "hint" }, `Not in the record: ${res.gaps.join("; ")}`));
  if (res.dropped_ungrounded) out.push(el("p", { class: "hint" }, `${res.dropped_ungrounded} statement(s) without support in the record were removed.`));
  $("ai-output").replaceChildren(...out);
  await refreshActivity();
});

$("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question) return;
  const res = await assistant("Looking in the record", "ask", { question });
  if (!res) return;
  $("ai-output").replaceChildren(
    el("p", { class: "q" }, question),
    el("p", { class: res.grounded ? "" : "warn" }, res.answer, " ", citations(res.citations)),
    el("small", {}, `Confidence: ${res.confidence}`));
  await refreshActivity();
});

for (const kind of ["handover", "discharge"]) {
  $(`btn-${kind}`).addEventListener("click", async () => {
    const res = await assistant(`Drafting ${kind}`, "draft", { kind });
    if (!res) return;
    $("ai-output").replaceChildren(el("p", {}, `Draft saved in Notes for review and signature${res.unsupported_sections ? ` (${res.unsupported_sections} section(s) marked UNSUPPORTED)` : ""}.`));
    await openPatient(current);
  });
}

async function refreshActivity() {
  const r = await api(`/api/patients/${current}`);
  $("ai-activity").replaceChildren(...r.ai_interactions.map((i) =>
    el("li", {}, `${time(i.at)} · ${i.feature} · ${i.outcome} · ${i.citations} citation(s) · ${i.input_tokens + i.output_tokens} tokens`)));
}

start();
