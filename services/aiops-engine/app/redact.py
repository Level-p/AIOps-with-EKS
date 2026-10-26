"""Remove patient data and secrets from evidence BEFORE it leaves the cluster (to the LLM or Slack).

HealthTech rule: the AI provider must never receive protected health information
(PHI) or credentials. Redaction runs on every string of evidence; anything that
looks like an identifier is replaced, patient ids by a stable pseudonym so the
model can still see "the same patient appears in 40 errors".
"""

import hashlib
import re

_PATTERNS = [
    # Secrets first, so nothing below partially matches them
    (re.compile(r"(?i)\b(authorization|bearer|x-[a-z-]*token|api[_-]?key|password|passwd|secret|token)\b(\s*[:=]\s*|\s+)[\"']?(?:bearer\s+)?[^\s\"',}]+"),
     lambda m: f"{m.group(1)}{m.group(2)}[REDACTED-SECRET]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), lambda m: "[REDACTED-JWT]"),
    (re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"), lambda m: "[REDACTED-AWS-KEY]"),
    (re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}\b"), lambda m: "[REDACTED-SLACK-TOKEN]"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}\b"), lambda m: "[REDACTED-API-KEY]"),
    (re.compile(r"postgres(ql)?(\+\w+)?://[^\s\"']+"), lambda m: "postgresql://[REDACTED-DSN]"),
    # Personal data
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), lambda m: "[REDACTED-EMAIL]"),
    (re.compile(r"\b\d{3}[ -]?\d{3}[ -]?\d{4}\b"), lambda m: "[REDACTED-NUMBER]"),      # NHS-number / phone-like
    (re.compile(r"\+\d{1,3}[ \d-]{7,}\d"), lambda m: "[REDACTED-PHONE]"),
    (re.compile(r"(?i)\b(pseudonym|patient_name|name|dob|date_of_birth|address)\b(\"?\s*[:=]\s*\"?)[^\",}\n]+"),
     lambda m: f"{m.group(1)}{m.group(2)}[REDACTED-PII]"),
]
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)


def _pseudonym(match: re.Match) -> str:
    return "id-" + hashlib.sha256(match.group(0).lower().encode()).hexdigest()[:8]


def redact(text: str, max_len: int = 2000) -> str:
    if not isinstance(text, str):
        text = str(text)
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    text = _UUID.sub(_pseudonym, text)
    return text if len(text) <= max_len else text[:max_len] + "…[truncated]"


def redact_obj(obj, max_len: int = 2000):
    """Redact every string inside dicts/lists (keys kept as they are)."""
    if isinstance(obj, dict):
        return {k: redact_obj(v, max_len) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact_obj(v, max_len) for v in obj]
    if isinstance(obj, str):
        return redact(obj, max_len)
    return obj
