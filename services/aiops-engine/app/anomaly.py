"""Statistical anomaly detection on Prometheus series (no ML platform needed).

Robust z-score: how many "typical deviations" the latest value is from the
recent normal, using the median and the median absolute deviation (MAD), which
a few spikes in the history cannot distort the way a mean and standard
deviation can. A signal is anomalous only after it stays beyond the threshold
for several consecutive evaluations (avoids paging on one noisy sample).
"""

from dataclasses import dataclass, field
from statistics import median

MAD_TO_SIGMA = 1.4826  # makes MAD comparable to a standard deviation for normal data


def robust_z(history: list[float], latest: float, min_points: int = 30, floor: float = 1e-9) -> float | None:
    """z-score of `latest` against `history`; None when there is too little history to judge."""
    clean = [v for v in history if v == v]  # drop NaN
    if len(clean) < min_points:
        return None
    med = median(clean)
    mad = median(abs(v - med) for v in clean) * MAD_TO_SIGMA
    if mad < floor:
        # Flat history: any change is notable, but scale it relative to the level so 0 -> 0.001 is not "infinite"
        mad = max(abs(med) * 0.05, floor)
    return (latest - med) / mad


@dataclass
class Signal:
    """One SLI to watch. direction: 'up' (only increases are bad), 'down', or 'both'."""
    name: str
    query: str
    direction: str = "up"
    threshold: float = 4.0
    consecutive: int = 3
    description: str = ""
    _streak: int = field(default=0, repr=False)

    def evaluate(self, history: list[float], latest: float) -> tuple[bool, float | None]:
        z = robust_z(history, latest)
        if z is None:
            self._streak = 0
            return False, None
        bad = (z > self.threshold if self.direction == "up" else
               z < -self.threshold if self.direction == "down" else abs(z) > self.threshold)
        self._streak = self._streak + 1 if bad else 0
        return self._streak == self.consecutive, z   # fire once, when the streak reaches N


# What CareSignal watches. The metric names are the OpenTelemetry names after the
# collector's Prometheus remote-write conversion (dots -> underscores, unit and _total suffixes).
DEFAULT_SIGNALS = [
    Signal("ingest-rate-drop",
           'sum(rate(caresignal_vitals_ingested_total{k8s_namespace_name="caresignal-prod"}[5m]))',
           direction="down", description="Device readings arriving per second dropped sharply (devices offline or ingest broken)"),
    Signal("high-risk-share",
           'sum(rate(caresignal_vitals_ingested_total{k8s_namespace_name="caresignal-prod",risk="high"}[15m]))'
           ' / clamp_min(sum(rate(caresignal_vitals_ingested_total{k8s_namespace_name="caresignal-prod"}[15m])), 1e-6)',
           direction="up", description="Share of high early-warning scores is unusual (clinical event or faulty devices)"),
    Signal("ingest-latency-p95",
           'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="vitals-ingest",k8s_namespace_name="caresignal-prod"}[5m])))',
           direction="up", description="p95 latency of vitals-ingest is unusual"),
    Signal("api-error-ratio",
           'sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="caresignal-prod",http_response_status_code=~"5.."}[5m]))'
           ' / clamp_min(sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="caresignal-prod"}[5m])), 1e-6)',
           direction="up", description="Share of 5xx answers is unusual"),
    # LLM operations of the clinical assistant
    Signal("llm-token-rate",
           'sum(rate(caresignal_llm_tokens_total{k8s_namespace_name="caresignal-prod"}[15m]))',
           direction="up", description="Model tokens per second are unusual (runaway client, prompt growth, abuse)"),
    Signal("llm-guardrail-blocks",
           'sum(rate(caresignal_llm_guardrail_blocks_total{k8s_namespace_name="caresignal-prod"}[15m]))',
           direction="up", description="Requests refused by the assistant's guardrails are unusual (probing or misuse)"),
]
