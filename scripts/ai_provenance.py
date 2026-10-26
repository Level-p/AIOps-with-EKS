#!/usr/bin/env python3
"""AI-assisted development policy check for pull requests.

Policy (docs: AI-assisted development):
  - AI help is welcome, but it must be DISCLOSED: the PR carries the label "ai-assisted"
    and ticks the box in the PR template. Commits with an AI co-author trailer
    (Co-Authored-By: Claude / Copilot / ...) or "AI-Assisted: yes" without the label fail.
  - AI-assisted changes to service code must change or add tests in the same PR.
  - AI-assisted PRs get the strict "ai-code" Semgrep rules as blocking (security.yml) and
    need a CODEOWNERS review (branch protection) before merge.

Inputs (GitHub Actions): GITHUB_EVENT_PATH (pull_request event), and the base/head SHAs
to list commits and changed files with git.
"""

import json
import os
import re
import subprocess
import sys

AI_TRAILER = re.compile(
    r"^(co-authored-by:.*\b(claude|anthropic|copilot|cursor|codeium|windsurf|gemini|chatgpt|openai|devin|amazon q|codewhisperer)\b"
    r"|ai-assisted:\s*(yes|true))", re.IGNORECASE | re.MULTILINE)
DISCLOSURE_BOX = re.compile(r"-\s*\[[xX]\]\s*This PR contains AI-assisted code", re.IGNORECASE)


def git(*args) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def evaluate(labels: set[str], body: str, commit_messages: list[str], changed_files: list[str]) -> tuple[list[str], list[str]]:
    """Returns (errors, notes)."""
    errors, notes = [], []
    ai_commits = [m.splitlines()[0] for m in commit_messages if AI_TRAILER.search(m)]
    labelled = "ai-assisted" in labels
    disclosed = bool(DISCLOSURE_BOX.search(body or ""))

    if ai_commits and not labelled:
        errors.append(f"{len(ai_commits)} commit(s) have an AI co-author trailer but the PR has no 'ai-assisted' label: "
                      + "; ".join(ai_commits[:3]))
    if labelled and not disclosed:
        errors.append("Label 'ai-assisted' is set but the disclosure box in the PR description is not ticked.")
    if disclosed and not labelled:
        errors.append("The disclosure box is ticked: add the 'ai-assisted' label too (it switches on the strict checks).")

    if labelled or ai_commits:
        is_test = lambda f: "/tests/" in f or "/test/" in f  # noqa: E731 (pytest: tests/, node --test: test/)
        code = [f for f in changed_files if f.startswith("services/") and not is_test(f) and f.endswith((".py", ".js"))]
        tests = [f for f in changed_files if is_test(f)]
        if code and not tests:
            errors.append("AI-assisted change to service code without any test change: add or update tests "
                          f"({', '.join(code[:5])}).")
        notes.append("AI-assisted PR: strict ai-code Semgrep rules are blocking and a CODEOWNERS review is required.")
    return errors, notes


def main():
    event = json.load(open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8"))
    pr = event["pull_request"]
    base, head = pr["base"]["sha"], pr["head"]["sha"]
    labels = {l["name"] for l in pr.get("labels", [])}
    messages = [m for m in git("log", "--format=%B%x00", f"{base}..{head}").split("\x00") if m.strip()]
    files = git("diff", "--name-only", f"{base}...{head}").split()
    errors, notes = evaluate(labels, pr.get("body") or "", messages, files)
    for n in notes:
        print(f"::notice::{n}")
    for e in errors:
        print(f"::error::{e}")
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as s:
        s.write("### AI-assisted development check\n" + ("\n".join(f"- ❌ {e}" for e in errors) or "- ✅ policy satisfied") + "\n")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
