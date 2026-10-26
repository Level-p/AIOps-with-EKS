"""Slack message (Block Kit) for an incident, sent to an incoming webhook."""

import logging
import os

import httpx

from .triage import RUNBOOKS, Triage

log = logging.getLogger("aiops.slack")
EMOJI = {"critical": ":red_circle:", "warning": ":large_orange_circle:", "info": ":large_blue_circle:"}


def message(title: str, severity: str, status: str, triage: Triage, source: str, grafana_url: str) -> dict:
    head = f"{EMOJI.get(severity, ':white_circle:')} [{status.upper()}] {title}"
    bullets = lambda items: "\n".join(f"• {i}" for i in items) or "–"
    return {
        "text": f"{head}: {triage.summary}",   # fallback for notifications
        "blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": head[:150]}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*Summary*\n{triage.summary}"}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Probable cause* ({triage.confidence} confidence)\n{triage.probable_cause}"},
                {"type": "mrkdwn", "text": f"*Runbook*\n`{triage.recommended_runbook}`: {RUNBOOKS[triage.recommended_runbook]}"},
            ]},
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*Evidence*\n{bullets(triage.evidence)}"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*Next steps (for a human)*\n{bullets(triage.next_steps)}"}},
            {"type": "context", "elements": [{"type": "mrkdwn", "text":
                f"Triage: {source}. AI suggestions can be wrong: verify before acting. "
                f"<{grafana_url}|Open Grafana>"}]},
        ],
    }


async def post(payload: dict) -> bool:
    url = os.environ.get("SLACK_WEBHOOK_URL", "")
    if not url:
        log.info("no Slack webhook configured; incident logged only", extra={"text": payload["text"][:200]})
        return False
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(url, json=payload)
    if r.status_code != 200:
        log.error("Slack rejected the message", extra={"status": r.status_code})
        return False
    return True
