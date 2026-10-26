# Security policy

CareSignal is a demonstration HealthTech platform that uses **synthetic data only**.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Report a vulnerability** (Security tab →
Advisories) with steps to reproduce. You will get an answer within 3 working days.

## What protects this repository

- Every change goes through a pull request with a CODEOWNERS review, Gitleaks, Semgrep
  (including rules for AI-generated code), CodeQL, a dependency guard, pip-audit,
  Checkov and Kyverno policy checks.
- Images are built only by `.github/workflows/app.yml`, scanned with Trivy, signed with
  Cosign (keyless), shipped with an SBOM and SLSA provenance; the cluster runs only
  images signed by that workflow on `main`.
- No long-lived cloud credentials exist: GitHub Actions uses OIDC.
