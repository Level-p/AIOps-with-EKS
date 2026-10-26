# DAST: OWASP ZAP

SAST (Semgrep, CodeQL) reads the code. **DAST attacks the running application**: real HTTP, real
authentication, real routing, real headers and error pages, injection that reaches the real
database. It finds what only exists at runtime. The first scan here found that Express's built-in
404 page replaced the helmet CSP with `default-src 'none'` (no `frame-ancestors`, no
`form-action`). That is now fixed (`notFound` in `src/common.js`) and covered by a test in each service.

| File | What it is |
|---|---|
| `openapi/caresignal.yaml` | The public API contract (what the ALB exposes). ZAP imports it so the scan reaches every operation and parameter, not just what a crawler finds |
| `zap/ci-full.yaml` | ZAP Automation Framework plan: **full scan** (passive + active attacks), authenticated, of an ephemeral stack started inside CI |
| `zap/stage-baseline.yaml` | **Baseline** (passive, read-only operations) of the deployed stage behind the real ALB and WAF |
| `gateway.js` | Mirrors the ingress routing in CI (one origin; `/internal/*` answers 404) |
| `run-zap.sh` | Runs a plan in the digest-pinned `ghcr.io/zaproxy/zaproxy:2.17.0` image, then the gate |
| `zap_gate.py` | Pass/fail from the JSON report; reviewed, expiring exceptions; Markdown summary; JUnit XML |
| `zap-policy.json` | The gate: `fail_on` and the exceptions (`plugin_id`, `reason`, `owner`, `expires`, optional `uri_regex`) |
| `tests/` | Unit tests for the gate (`python -m pytest -q dast/tests`) |

## Where it runs (`.github/workflows/dast.yml`)

| Trigger | Job | Target | Scan |
|---|---|---|---|
| Pull request, push to main | `ephemeral` | PostgreSQL service container + the three services + `gateway.js` on the runner | Full (active). Synthetic data, discarded afterwards |
| Nightly, on demand | `stage` | `https://caresignal-stage.<domain>` | Baseline (passive) |
| `promote.yml` | `dast` (calls `dast.yml`) | stage, which runs exactly the versions about to be promoted | Baseline. **Production promotion needs it to pass** |

Active scans send attack payloads and write data, so they run only against environments built
for that purpose, never against a shared one.

## Triage a finding

1. Open the job summary (table) or the `zap-*` artifact (`zap-report.html`: request, response, attack, evidence).
2. Reproduce it with `curl`. Decide whether it is **real** or a **false positive**.
3. If it's real, fix the code, add a test, and re-run.
4. If it's a false positive, add an `alertFilter` job to the plan, as narrow as possible (rule, URL,
   parameter, attack), with the evidence in a comment. The PR review is the security review.
5. If it's a real risk that's accepted for now, add an exception to `zap-policy.json` with an owner and
   an expiry date of at most 180 days. When it expires the build fails again.

## Run it on a laptop

```bash
# Docker: start the stack as dast.yml does, then
CLINICIAN_TOKEN=... DEVICE_TOKEN=... bash dast/run-zap.sh ci-full http://localhost:8080 <patient-id>
```

Stage needs the environment secrets `STAGE_CLINICIAN_TOKEN` and `STAGE_DEVICE_TOKEN` (environment `stage`).
