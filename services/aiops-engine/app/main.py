"""aiops-engine: alert enrichment, anomaly detection and AI-assisted triage for CareSignal.

  POST /alertmanager   Alertmanager webhook (Bearer token): every firing group is enriched with
                       evidence, triaged, and posted to Slack; resolved groups get a short notice
  GET  /metrics        the engine's own metrics (Prometheus)
  GET  /healthz
Background: every AIOPS_INTERVAL seconds the anomaly detector checks the SLIs in app/anomaly.py.
"""

import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, generate_latest

from . import slack
from .anomaly import DEFAULT_SIGNALS
from .evidence import Evidence
from .logs import setup_logging
from .redact import redact
from .triage import Triager

setup_logging("aiops-engine")
log = logging.getLogger("aiops")

INCIDENTS = Counter("aiops_incidents_total", "Incidents processed", ["source", "triage"])
ANOMALY_Z = Gauge("aiops_anomaly_zscore", "Latest robust z-score per watched signal", ["signal"])
DETECTOR_ERRORS = Counter("aiops_detector_errors_total", "Failed anomaly evaluations", ["signal"])

GRAFANA_URL = os.environ.get("GRAFANA_URL", "https://grafana.example.com")
evidence = Evidence(os.environ.get("PROMETHEUS_URL", "http://kube-prometheus-stack-prometheus.monitoring:9090"),
                    os.environ.get("LOKI_URL", "http://loki.observability:3100"))
triager = Triager()
_background: set[asyncio.Task] = set()   # keep references so tasks are not garbage-collected


async def handle_incident(key: str, alert: dict, source: str):
    labels = alert.get("labels", {})
    ev = await evidence.collect(alert)
    result, how = await triager.triage(key, alert, ev)
    title = redact(labels.get("alertname", "incident") + (f" ({labels['namespace']})" if labels.get("namespace") else ""), 140)
    await slack.post(slack.message(title, labels.get("severity", "warning"), "firing", result, how, GRAFANA_URL))
    INCIDENTS.labels(source=source, triage="ai" if how.startswith("ai") else "rule").inc()
    log.info("incident triaged", extra={"key": key, "triage": how, "runbook": result.recommended_runbook})


async def detector_loop():
    interval = int(os.environ.get("AIOPS_INTERVAL", "60"))
    while True:
        for signal in DEFAULT_SIGNALS:
            try:
                history = await evidence.query_range(signal.query, minutes=120)
                if len(history) < 6:
                    continue
                fire, z = signal.evaluate(history[:-5], history[-1])   # judge now against the last 2 h minus 5 min
                if z is not None:
                    ANOMALY_Z.labels(signal=signal.name).set(z)
                if fire:
                    alert = {"labels": {"alertname": f"Anomaly: {signal.name}", "severity": "warning",
                                        "namespace": "caresignal-prod", "aiops_query": signal.query},
                             "annotations": {"summary": f"{signal.description} (robust z-score {z:.1f})"}}
                    await handle_incident(f"anomaly:{signal.name}", alert, "anomaly")
            except Exception:
                DETECTOR_ERRORS.labels(signal=signal.name).inc()
                log.exception("anomaly evaluation failed", extra={"signal": signal.name})
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(_):
    task = asyncio.create_task(detector_loop()) if os.environ.get("AIOPS_DETECTOR", "on") == "on" else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="CareSignal aiops-engine", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "ai": triager.enabled}


@app.get("/metrics")
def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/alertmanager", status_code=202)
async def alertmanager(request: Request, authorization: str | None = Header(default=None)):
    expected = os.environ.get("WEBHOOK_TOKEN", "")
    scheme, _, token = (authorization or "").partition(" ")
    if not expected or scheme != "Bearer" or not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="unauthorised")
    body = await request.json()
    key = body.get("groupKey", "")
    if body.get("status") == "resolved":
        labels = body.get("commonLabels", {})
        await slack.post({"text": f":large_green_circle: [RESOLVED] {redact(labels.get('alertname', 'incident'), 140)}"})
        return {"accepted": 0}
    firing = [a for a in body.get("alerts", []) if a.get("status") == "firing"]
    if firing:
        # One triage per group: the first alert plus how many others share it
        first = firing[0]
        first.setdefault("annotations", {})["group_size"] = str(len(firing))
        task = asyncio.create_task(handle_incident(key, first, "alertmanager"))
        _background.add(task)
        task.add_done_callback(_background.discard)
    return {"accepted": len(firing)}
