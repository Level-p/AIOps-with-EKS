#!/usr/bin/env bash
# Run one OWASP ZAP Automation Framework plan in the pinned ZAP container, then the gate.
#
#   dast/run-zap.sh <plan> <target-url> <patient-id>
#     plan        ci-full | stage-baseline        (dast/zap/<plan>.yaml)
#     env         CLINICIAN_TOKEN, DEVICE_TOKEN    (never printed)
#                 FAIL_ON (optional: low | medium | high; default from dast/zap-policy.json)
#
# Output: dast/reports/zap-report.{json,sarif,html}, zap-junit.xml; exit code of the gate
# (0 pass, 1 findings, 2 scan or report broken).
set -euo pipefail

PLAN="$1"; TARGET_URL="$2"; PATIENT_ID="$3"
cd "$(dirname "$0")"
# The image is pinned by digest: the scanner itself is part of the supply chain
ZAP_IMAGE="ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6"

rm -rf reports && mkdir -p reports
# The spec with a real patient id; the baseline gets the read-only operations only (no writes,
# no LLM calls in a shared environment)
sed "s/PATIENT_ID_PLACEHOLDER/${PATIENT_ID}/g" openapi/caresignal.yaml > openapi/caresignal.generated.yaml
if [ "$PLAN" = stage-baseline ]; then
  yq -i 'del(.paths[].post) | del(.paths[] | select(length == 0))' openapi/caresignal.generated.yaml
fi
# The container runs as the "zap" user (uid 1000): it must be able to write the reports
chmod -R a+rwX reports openapi

set +e
docker run --rm --network host \
  -v "$PWD:/zap/wrk/dast:rw" \
  -e TARGET_URL="$TARGET_URL" -e DAST_DIR=/zap/wrk/dast \
  -e CLINICIAN_TOKEN -e DEVICE_TOKEN \
  "$ZAP_IMAGE" zap.sh -cmd -port 18080 -autorun "/zap/wrk/dast/zap/${PLAN}.yaml" 2>&1 | tee reports/zap.log
ZAP_EXIT=${PIPESTATUS[0]}
set -e
rm -f openapi/caresignal.generated.yaml
if [ ! -s reports/zap-report.json ]; then
  echo "::error::ZAP produced no report (exit $ZAP_EXIT): the plan failed before scanning. See the log above."
  exit 2
fi
# ZAP exits 1 for plan errors and 2 for warnings. Fail on errors and on failed edge
# assertions (requestor responseCode); report other warnings (e.g. no page at an API's /).
PLAN_FAILED=0
if [ "$ZAP_EXIT" -eq 1 ]; then echo "::error::ZAP plan failed (exit 1); see the log."; PLAN_FAILED=1; fi
if grep -q "Difference in response code" reports/zap.log; then
  echo "::error::An edge assertion failed (requestor): $(grep -m1 "Difference in response code" reports/zap.log)"; PLAN_FAILED=1
fi
if [ "$ZAP_EXIT" -eq 2 ] && [ "$PLAN_FAILED" -eq 0 ]; then echo "::warning::ZAP plan warnings (not blocking); see the log."; fi

python3 zap_gate.py reports/zap-report.json --policy zap-policy.json ${FAIL_ON:+--fail-on "$FAIL_ON"} \
  --title "OWASP ZAP DAST ($PLAN)" --junit reports/zap-junit.xml \
  ${GITHUB_STEP_SUMMARY:+--summary "$GITHUB_STEP_SUMMARY"} || GATE=$?
GATE=${GATE:-0}
if [ "$GATE" -eq 0 ] && [ "$PLAN_FAILED" -ne 0 ]; then exit 1; fi
exit "$GATE"
