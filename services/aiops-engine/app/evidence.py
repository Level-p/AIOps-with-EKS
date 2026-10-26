"""Collect evidence for an incident, read-only, each source with a short timeout.

  Prometheus  current value of the alert's expression and recent SLI values
  Loki        the latest error/warning log lines from the affected namespace
  Kubernetes  recent Warning events (OOMKilled, BackOff, FailedScheduling...)
  Argo CD     what was deployed last and when ("what changed?")

A failing source never blocks the incident: it is reported as unavailable.
The service account only has get/list on events and Argo CD Applications.
"""

import asyncio
import logging
import time
from pathlib import Path

import httpx

log = logging.getLogger("aiops.evidence")
SA = Path("/var/run/secrets/kubernetes.io/serviceaccount")


class Evidence:
    def __init__(self, prometheus_url: str, loki_url: str, k8s_url: str = "https://kubernetes.default.svc",
                 argocd_namespace: str = "argocd", timeout: float = 5.0):
        self.prometheus_url = prometheus_url.rstrip("/")
        self.loki_url = loki_url.rstrip("/")
        self.k8s_url = k8s_url
        self.argocd_namespace = argocd_namespace
        self.http = httpx.AsyncClient(timeout=timeout)
        self.k8s = None
        if (SA / "token").exists():
            self.k8s = httpx.AsyncClient(timeout=timeout, verify=str(SA / "ca.crt"),
                                         headers={"Authorization": f"Bearer {(SA / 'token').read_text().strip()}"})

    # ---- Prometheus ----
    async def query(self, promql: str) -> list[dict]:
        r = await self.http.get(f"{self.prometheus_url}/api/v1/query", params={"query": promql})
        r.raise_for_status()
        return r.json()["data"]["result"]

    async def query_range(self, promql: str, minutes: int = 120, step: str = "60s") -> list[float]:
        end = time.time()
        r = await self.http.get(f"{self.prometheus_url}/api/v1/query_range",
                                params={"query": promql, "start": end - minutes * 60, "end": end, "step": step})
        r.raise_for_status()
        result = r.json()["data"]["result"]
        return [float(v) for _, v in result[0]["values"]] if result else []

    # ---- Loki ----
    async def error_logs(self, namespace: str, limit: int = 20) -> list[str]:
        logql = f'{{k8s_namespace_name="{namespace}"}} |~ "(?i)(error|warn|exception|traceback)"'
        r = await self.http.get(f"{self.loki_url}/loki/api/v1/query_range",
                                params={"query": logql, "limit": limit, "since": "15m", "direction": "backward"})
        r.raise_for_status()
        lines = [line for stream in r.json()["data"]["result"] for _, line in stream["values"]]
        return lines[:limit]

    # ---- Kubernetes ----
    async def warning_events(self, namespace: str, limit: int = 15) -> list[str]:
        if not self.k8s:
            return []
        r = await self.k8s.get(f"{self.k8s_url}/api/v1/namespaces/{namespace}/events",
                               params={"fieldSelector": "type=Warning", "limit": 100})
        r.raise_for_status()
        items = sorted(r.json().get("items", []),
                       key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "", reverse=True)
        return [f'{e.get("lastTimestamp") or e.get("eventTime")} {e["involvedObject"]["kind"]}/{e["involvedObject"]["name"]} '
                f'{e.get("reason")}: {e.get("message", "")}' for e in items[:limit]]

    async def recent_deploys(self) -> list[str]:
        if not self.k8s:
            return []
        r = await self.k8s.get(f"{self.k8s_url}/apis/argoproj.io/v1alpha1/namespaces/{self.argocd_namespace}/applications")
        r.raise_for_status()
        out = []
        for app in r.json().get("items", []):
            status = app.get("status", {})
            history = status.get("history") or []
            if history:
                last = history[-1]
                out.append(f'{app["metadata"]["name"]}: revision {str(last.get("revision", ""))[:12]} deployed at {last.get("deployedAt")}; '
                           f'sync={status.get("sync", {}).get("status")} health={status.get("health", {}).get("status")}')
        return out

    # ---- everything for one alert ----
    async def collect(self, alert: dict) -> dict:
        labels = alert.get("labels", {})
        namespace = labels.get("namespace") or labels.get("k8s_namespace_name") or "caresignal-prod"

        async def safe(name, coro):
            try:
                return name, await asyncio.wait_for(coro, timeout=8)
            except Exception as e:
                log.warning("evidence source failed", extra={"source": name, "error": type(e).__name__})
                return name, f"unavailable ({type(e).__name__})"

        tasks = [safe("logs", self.error_logs(namespace)), safe("events", self.warning_events(namespace)),
                 safe("deploys", self.recent_deploys())]
        if expr := alert.get("annotations", {}).get("query") or labels.get("aiops_query"):
            tasks.append(safe("metric", self.query(expr)))
        return dict(await asyncio.gather(*tasks))
