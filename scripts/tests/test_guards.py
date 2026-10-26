import datetime as dt
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import ai_provenance  # noqa: E402
import dependency_guard as guard  # noqa: E402

NOW = dt.datetime(2026, 10, 18, tzinfo=dt.timezone.utc)


def make_repo(tmp_path, requirements, approved, workflow):
    (tmp_path / "services" / "svc").mkdir(parents=True)
    (tmp_path / "services" / "svc" / "requirements.in").write_text(requirements)
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    (tmp_path / ".github" / "approved-dependencies.txt").write_text(approved)
    (tmp_path / ".github" / "workflows" / "ci.yml").write_text(workflow)
    return tmp_path


def fake_pypi(ages: dict):
    def fetch(url):
        name = url.split("/pypi/")[1].split("/")[0]
        if name not in ages:
            raise OSError("404")
        t = (NOW - dt.timedelta(days=ages[name])).isoformat().replace("+00:00", "Z")
        return {"releases": {"1.0": [{"upload_time_iso_8601": t}]}}
    return fetch


PINNED = "steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"


def test_clean_repo_passes(tmp_path):
    root = make_repo(tmp_path, "fastapi==1.0\nhttpx==0.28\n", "fastapi\nhttpx\n", PINNED)
    assert guard.check(root, fetch=fake_pypi({"fastapi": 2000, "httpx": 1500}), now=NOW) == []


def test_hallucinated_package_fails(tmp_path):
    root = make_repo(tmp_path, "fastapi-secure-auth-helper==0.1\n", "fastapi-secure-auth-helper\n", PINNED)
    problems = guard.check(root, fetch=fake_pypi({}), now=NOW)
    assert any("does not exist on PyPI" in p for p in problems)


def test_brand_new_package_fails(tmp_path):
    root = make_repo(tmp_path, "shiny==0.1\n", "shiny\n", PINNED)
    problems = guard.check(root, fetch=fake_pypi({"shiny": 3}), now=NOW)
    assert any("first published 3 days ago" in p for p in problems)


def test_unapproved_dependency_fails_and_names_are_normalised(tmp_path):
    root = make_repo(tmp_path, "Python_Dateutil==2.9\nnew-thing==1\n", "python-dateutil\n", PINNED)
    problems = guard.check(root, offline=True, now=NOW)
    assert problems == ["services/svc/requirements.in: 'new-thing' is not on .github/approved-dependencies.txt (new dependency: needs review)"]


def test_extras_and_options_are_parsed(tmp_path):
    root = make_repo(tmp_path, "-r other.txt\npsycopg[binary]==3.3 # db\n\n", "psycopg\n", PINNED)
    assert guard.check(root, offline=True, now=NOW) == []


@pytest.mark.parametrize("line, ok", [
    ("      - uses: actions/checkout@v7", False),
    ("      - uses: actions/checkout@main", False),
    ("      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", True),
    ("        uses: ./.github/actions/local", True),
    ("      - uses: docker://alpine:3.20", True),
])
def test_action_pinning(tmp_path, line, ok):
    root = make_repo(tmp_path, "", "", f"steps:\n{line}\n")
    assert (guard.check(root, offline=True, now=NOW) == []) is ok


# ---------------- npm ----------------
import json  # noqa: E402


def make_npm_repo(tmp_path, deps, approved, lock_overrides=None):
    svc = tmp_path / "services" / "web"
    svc.mkdir(parents=True)
    (svc / "package.json").write_text(json.dumps({"name": "web", "dependencies": deps}))
    packages = {"": {"name": "web"}}
    for name, version in deps.items():
        packages[f"node_modules/{name}"] = {"version": version.lstrip("^~"), "resolved": f"https://registry.npmjs.org/{name}/-/x.tgz",
                                            "integrity": "sha512-abc"}
    packages.update(lock_overrides or {})
    (svc / "package-lock.json").write_text(json.dumps({"lockfileVersion": 3, "packages": packages}))
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    (tmp_path / ".github" / "approved-dependencies.txt").write_text(approved)
    (tmp_path / ".github" / "workflows" / "ci.yml").write_text(PINNED)
    return tmp_path


def fake_npm(packages: dict):
    """packages: name -> (age of the package in days, {version: age in days})"""
    def fetch(url):
        name = url.split("registry.npmjs.org/")[1].replace("%2F", "/")
        if name not in packages:
            raise OSError("404")
        created, versions = packages[name]
        iso = lambda days: (NOW - dt.timedelta(days=days)).isoformat().replace("+00:00", "Z")
        return {"time": {"created": iso(created), **{v: iso(a) for v, a in versions.items()}}}
    return fetch


def test_npm_clean_repo_passes(tmp_path):
    root = make_npm_repo(tmp_path, {"express": "5.3.0", "@anthropic-ai/sdk": "0.133.0"}, "express\n@anthropic-ai/sdk\n")
    fetch = fake_npm({"express": (5000, {"5.3.0": 9}), "@anthropic-ai/sdk": (1000, {"0.133.0": 9})})
    assert guard.check(root, fetch=fetch, now=NOW) == []


def test_npm_hallucinated_new_unapproved_and_fresh_versions_fail(tmp_path):
    deps = {"express-secure-session-guard": "1.0.0", "shiny": "1.0.0", "express": "5.3.1", "left-pad": "1.3.0"}
    root = make_npm_repo(tmp_path, deps, "express-secure-session-guard\nshiny\nexpress\n")
    fetch = fake_npm({"shiny": (3, {"1.0.0": 3}), "express": (5000, {"5.3.1": 2}), "left-pad": (4000, {"1.3.0": 3000})})
    problems = "\n".join(guard.check(root, fetch=fetch, now=NOW))
    assert "'express-secure-session-guard' does not exist on npm" in problems
    assert "'shiny' was first published 3 days ago" in problems
    assert "'express@5.3.1' was released 2 days ago (cooldown 7 days)" in problems
    assert "'left-pad' is not on .github/approved-dependencies.txt" in problems


def test_npm_ranges_and_lockfile_integrity(tmp_path):
    root = make_npm_repo(tmp_path, {"express": "^5.3.0"}, "express\n", lock_overrides={
        "node_modules/evil": {"version": "1.0.0", "resolved": "https://evil.example/evil.tgz", "integrity": "sha1-abc"}})
    problems = "\n".join(guard.check(root, offline=True, now=NOW))
    assert "'express' must be an exact version, not '^5.3.0'" in problems
    assert "node_modules/evil is not resolved from https://registry.npmjs.org/" in problems
    assert "node_modules/evil has no sha512 integrity hash" in problems


def test_npm_missing_lockfile_fails(tmp_path):
    root = make_npm_repo(tmp_path, {"express": "5.3.0"}, "express\n")
    (root / "services" / "web" / "package-lock.json").unlink()
    assert any("no package-lock.json" in p for p in guard.check(root, offline=True, now=NOW))


# ---------------- AI provenance ----------------
BOX = "## AI disclosure\n- [x] This PR contains AI-assisted code"
AI_COMMIT = "feat: add triage\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"


def test_undisclosed_ai_commit_fails():
    errors, _ = ai_provenance.evaluate(set(), "", [AI_COMMIT], ["services/x/app/main.py", "services/x/tests/test_x.py"])
    assert any("no 'ai-assisted' label" in e for e in errors)


def test_disclosed_ai_pr_with_tests_passes():
    errors, notes = ai_provenance.evaluate({"ai-assisted"}, BOX, [AI_COMMIT], ["services/x/app/main.py", "services/x/tests/test_x.py"])
    assert errors == [] and notes


def test_ai_code_without_tests_fails():
    errors, _ = ai_provenance.evaluate({"ai-assisted"}, BOX, [AI_COMMIT], ["services/x/app/main.py"])
    assert any("without any test change" in e for e in errors)


def test_label_and_box_must_agree():
    assert ai_provenance.evaluate({"ai-assisted"}, "", [], [])[0]
    assert ai_provenance.evaluate(set(), BOX, [], [])[0]


def test_human_only_pr_passes():
    assert ai_provenance.evaluate(set(), "", ["fix: typo"], ["README.md"]) == ([], [])


@pytest.mark.parametrize("trailer", ["Co-authored-by: GitHub Copilot <x@y>", "AI-Assisted: yes", "Co-Authored-By: Cursor Agent <a@b>"])
def test_trailer_detection(trailer):
    assert ai_provenance.AI_TRAILER.search(f"msg\n\n{trailer}")
