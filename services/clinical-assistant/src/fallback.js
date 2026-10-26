// Deterministic parts of the assistant, which work without any model:
//   safetyFlags   allergy and medication conflicts, high early-warning score: always computed,
//                 shown next to the AI summary (a model can miss them; rules do not)
//   ruleSummary   the structured facts of the record when the model is unavailable
//                 (budget, circuit breaker, provider error, refusal, ungrounded output)

// Allergy class -> medicines in that class (small demonstration list, not a drug database)
const ALLERGY_CLASSES = {
  penicillin: ["penicillin", "amoxicillin", "ampicillin", "flucloxacillin", "piperacillin", "co-amoxiclav", "benzylpenicillin", "phenoxymethylpenicillin"],
  sulfonamide: ["sulfamethoxazole", "co-trimoxazole", "sulfasalazine"],
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "aspirin", "ketorolac"],
  opioid: ["morphine", "codeine", "oxycodone", "tramadol", "fentanyl"],
};

function cidFor(index, type, id) {
  for (const [cid, ref] of index) if (ref.type === type && ref.id === id) return cid;
  return null;
}

function safetyFlags(record, index) {
  const flags = [];
  const active = record.medications.filter((m) => m.status === "active");
  for (const allergy of record.allergies) {
    const substance = allergy.substance.toLowerCase();
    const cls = Object.entries(ALLERGY_CLASSES).find(([name, members]) => substance.includes(name) || members.some((m) => substance.includes(m)));
    const members = cls ? cls[1] : [substance];
    for (const med of active) {
      if (members.some((m) => med.name.toLowerCase().includes(m))) {
        flags.push({
          type: "allergy_conflict",
          text: `Active medication ${med.name} may conflict with the recorded ${allergy.severity} allergy to ${allergy.substance}.`,
          citations: [cidFor(index, "medication", med.id), cidFor(index, "allergy", allergy.id)].filter(Boolean),
        });
      }
    }
  }
  const latest = record.readings[0];
  if (latest && latest.risk === "high") {
    flags.push({
      type: "high_news2",
      text: `Latest early-warning score is ${latest.score} (high): urgent clinical review is expected by the escalation policy.`,
      citations: [cidFor(index, "reading", latest.id)].filter(Boolean),
    });
  }
  return flags;
}

function ruleSummary(record, index) {
  const findings = [];
  const latest = record.readings[0];
  if (latest) {
    findings.push({ category: "vitals", text: `Latest NEWS2 ${latest.score} (${latest.risk}): HR ${latest.heart_rate}, RR ${latest.respiratory_rate}, SpO2 ${latest.spo2}%, systolic BP ${latest.systolic_bp}, temp ${Number(latest.temperature).toFixed(1)} °C.`, citations: [cidFor(index, "reading", latest.id)] });
  }
  for (const p of record.problems.filter((x) => x.status === "active")) findings.push({ category: "problem", text: p.description, citations: [cidFor(index, "problem", p.id)] });
  for (const m of record.medications.filter((x) => x.status === "active")) findings.push({ category: "medication", text: `${m.name} ${m.dose} ${m.route} ${m.frequency}`, citations: [cidFor(index, "medication", m.id)] });
  for (const a of record.allergies) findings.push({ category: "allergy", text: `${a.substance} (${a.severity})${a.reaction ? `: ${a.reaction}` : ""}`, citations: [cidFor(index, "allergy", a.id)] });
  return {
    overview: {
      text: `Structured summary from the record (the AI summary is not available): ${record.problems.filter((x) => x.status === "active").length} active problem(s), ${record.medications.filter((x) => x.status === "active").length} active medication(s), ${record.allergies.length} allergy record(s), ${record.notes.length} note(s).`,
      citations: [],
    },
    findings: findings.map((f) => ({ ...f, citations: f.citations.filter(Boolean) })),
    gaps: [],
    confidence: "high",
  };
}

module.exports = { safetyFlags, ruleSummary, ALLERGY_CLASSES };
