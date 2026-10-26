# Instructions for AI coding assistants (Claude Code, Copilot, Cursor...)

These rules are part of CareSignal's AI-assisted development policy. They apply to any
code, configuration or documentation an assistant writes in this repository. The same
rules are enforced by CI (`security.yml`, `ai-governance.yml`), so following them saves a
failed pipeline.

## Data

- CareSignal is HealthTech. **Never** put real patient data, names, dates of birth,
  contact details or identifiers in code, tests, fixtures, logs, prompts or commit messages.
  Use the synthetic generators and opaque UUIDs.
- Never paste secrets, tokens, `.env` files, kubeconfigs or Terraform state into a prompt.
- Log opaque ids only (`patient_id`), never pseudonyms, note text, questions or model answers.
  Compare tokens in constant time: `safeEqual` in `src/common.js` (Node), `hmac.compare_digest` (Python).

## Code

- Application services (`vitals-ingest`, `records-api`, `clinical-assistant`): Node.js 24, CommonJS,
  Express 5, Zod for every request body, `pg` with bound parameters only (`$1`, `$2`; no SQL built
  from strings). The dashboard writes data with `textContent`, never `innerHTML`.
- Platform service `aiops-engine`: Python 3.12, FastAPI.
- No `eval`/`new Function`/`exec`, no `child_process.exec` or `shell: true`/`shell=True`, no `pickle`,
  no `yaml.load` without `SafeLoader`, no `rejectUnauthorized: false`/`verify=False`.
- Every change to `services/*` comes with tests in the same change (`npm test` or `python -m pytest -q`).
- Containers: non-root, read-only root filesystem, no new capabilities.

## Dependencies (supply chain)

- Do not invent package names. Before adding a dependency, confirm it exists on npm or PyPI,
  is maintained, and is older than 30 days; add it to `.github/approved-dependencies.txt`
  with a reason.
- npm: exact versions only (`npm install --save-exact`, `.npmrc` has `save-exact` and
  `ignore-scripts`), a version at least 7 days old (release cooldown), and commit
  `package-lock.json`. Docker builds use `npm ci --omit=dev --ignore-scripts`.
- Python: regenerate `requirements.txt` with hashes:
  `pip-compile --generate-hashes --allow-unsafe -o requirements.txt requirements.in`.
- GitHub Actions are pinned to a full commit SHA with the version in a comment.

## LLM features (clinical-assistant, aiops-engine)

- Model output is untrusted: validate it with a schema (`messages.parse` + Zod/Pydantic), never
  execute it, never let it choose a URL, a command, a SQL query or HTML. The model suggests;
  clinicians and engineers act. The assistant has no tools and can only write DRAFT notes;
  only a clinician signs (`records-api`), and that must stay true.
- Minimum necessary context: one patient, no pseudonym, identifiers redacted
  (`src/guardrails.js`), record text escaped inside `<record>`; aiops-engine redacts evidence
  (`app/redact.py`).
- Every statement cites record items; keep the citation check and the "withhold ungrounded
  answers" rule. Keep the question guard, rate limit, token budget, circuit breaker and the
  deterministic fallback and safety flags.
- Telemetry carries metadata only (tokens, latency, outcome): never prompts, records or answers.
  Do not enable a content mode for LLM spans.

## Process

- Commits made with assistant help carry a trailer, e.g.
  `Co-Authored-By: Claude <noreply@anthropic.com>`; label the PR `ai-assisted` and tick the
  disclosure box. You must be able to explain every line you submit.
- Infrastructure changes go through `terraform plan` in CI; never run `terraform apply`
  or `kubectl apply` against shared environments from an assistant session.
