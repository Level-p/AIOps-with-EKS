#!/usr/bin/env python3
"""Supply-chain guard for dependencies and CI actions. Fails the build when:

  1. a direct dependency (npm or PyPI) does not exist     (an AI assistant "hallucinated" it;
     attackers register such names: "slopsquatting")
  2. a dependency was first published less than MIN_AGE_DAYS ago   (brand-new packages are
     where most malicious uploads live; give the ecosystem time to spot them)
  3. a dependency is not on the approved list            (new dependencies need a human decision:
     add them to .github/approved-dependencies.txt in the same pull request, reviewed by CODEOWNERS)
  4. npm: a version range instead of an exact version, a pinned version younger than
     COOLDOWN_DAYS (hijacked releases are usually pulled within days), or a lockfile entry
     without an sha512 integrity hash or from another registry
  5. a GitHub Action is not pinned to a full commit SHA  (a moved tag cannot change our build)

Usage: python scripts/dependency_guard.py [--offline]
"""

import argparse
import datetime as dt
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPROVED_FILE = ROOT / ".github" / "approved-dependencies.txt"
MIN_AGE_DAYS = 30
COOLDOWN_DAYS = 7
NPM_REGISTRY = "https://registry.npmjs.org/"
EXACT = re.compile(r"^\d+\.\d+\.\d+$")
REQ_LINE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(==|>=|~=|<=|>|<|!=)?")
USES = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)")
SHA = re.compile(r"^[0-9a-f]{40}$")


def normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_names(path: Path) -> list[str]:
    names = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith(("-", "--")):
            continue
        if m := REQ_LINE.match(line):
            names.append(normalise(m.group(1)))
    return names


def unpinned_actions(workflow: Path) -> list[str]:
    bad = []
    for n, line in enumerate(workflow.read_text(encoding="utf-8").splitlines(), 1):
        if m := USES.match(line):
            ref = m.group(1)
            if ref.startswith(("./", "docker://")):
                continue
            _, _, version = ref.partition("@")
            if not SHA.match(version):
                bad.append(f"{workflow.name}:{n}: {ref}")
    return bad


def pypi_first_release(name: str, fetch=None) -> dt.datetime | None:
    """Upload time of the package's first file on PyPI, or None if the package does not exist."""
    fetch = fetch or (lambda url: json.load(urllib.request.urlopen(url, timeout=15)))
    try:
        data = fetch(f"https://pypi.org/pypi/{name}/json")
    except Exception:
        return None
    times = [dt.datetime.fromisoformat(f["upload_time_iso_8601"].replace("Z", "+00:00"))
             for files in data.get("releases", {}).values() for f in files]
    return min(times) if times else None


def _iso(t: str) -> dt.datetime:
    return dt.datetime.fromisoformat(t.replace("Z", "+00:00"))


def npm_times(name: str, fetch=None) -> dict | None:
    """The registry's publish times ({"created": ..., "<version>": ...}), or None if the package does not exist."""
    fetch = fetch or (lambda url: json.load(urllib.request.urlopen(url, timeout=15)))
    try:
        return fetch(NPM_REGISTRY + name.replace("/", "%2F")).get("time") or None
    except Exception:
        return None


def check_npm(root: Path, approved: set[str], offline: bool, fetch, now: dt.datetime) -> list[str]:
    problems = []
    for manifest in sorted(root.glob("services/*/package.json")):
        where = manifest.relative_to(root).as_posix()
        pkg = json.loads(manifest.read_text(encoding="utf-8"))
        direct = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}

        lock_path = manifest.with_name("package-lock.json")
        if not lock_path.exists():
            problems.append(f"{where}: no package-lock.json (builds must be reproducible: npm ci)")
            lock = {}
        else:
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            for path, entry in lock.get("packages", {}).items():
                if not path or entry.get("link"):
                    continue
                if not str(entry.get("resolved", "")).startswith(NPM_REGISTRY):
                    problems.append(f"{lock_path.relative_to(root).as_posix()}: {path} is not resolved from {NPM_REGISTRY}")
                if not str(entry.get("integrity", "")).startswith("sha512-"):
                    problems.append(f"{lock_path.relative_to(root).as_posix()}: {path} has no sha512 integrity hash")

        for name, version in sorted(direct.items()):
            if name.lower() not in approved:
                problems.append(f"{where}: '{name}' is not on .github/approved-dependencies.txt (new dependency: needs review)")
            if not EXACT.match(version):
                problems.append(f"{where}: '{name}' must be an exact version, not '{version}'")
            locked = lock.get("packages", {}).get(f"node_modules/{name}", {}).get("version")
            if lock and locked != version:
                problems.append(f"{where}: '{name}' is {version} in package.json but {locked} in package-lock.json")
            if offline:
                continue
            times = npm_times(name, fetch)
            if times is None:
                problems.append(f"{where}: '{name}' does not exist on npm (hallucinated or typo-squatted name?)")
                continue
            if "created" in times and (now - _iso(times["created"])).days < MIN_AGE_DAYS:
                problems.append(f"{where}: '{name}' was first published {(now - _iso(times['created'])).days} days ago (< {MIN_AGE_DAYS})")
            if version not in times:
                problems.append(f"{where}: '{name}@{version}' does not exist on npm")
            elif (now - _iso(times[version])).days < COOLDOWN_DAYS:
                problems.append(f"{where}: '{name}@{version}' was released {(now - _iso(times[version])).days} days ago "
                                f"(cooldown {COOLDOWN_DAYS} days)")
    return problems


def check(root: Path = ROOT, offline: bool = False, fetch=None, now: dt.datetime | None = None) -> list[str]:
    now = now or dt.datetime.now(dt.timezone.utc)
    approved = {normalise(l.strip()) for l in (root / ".github" / "approved-dependencies.txt").read_text().splitlines()
                if l.strip() and not l.startswith("#")} if (root / ".github" / "approved-dependencies.txt").exists() else set()
    problems = []

    direct = {}
    for req in sorted(root.glob("services/*/requirements*.in")):
        for name in requirement_names(req):
            direct.setdefault(name, req.relative_to(root).as_posix())

    for name, where in sorted(direct.items()):
        if name not in approved:
            problems.append(f"{where}: '{name}' is not on .github/approved-dependencies.txt (new dependency: needs review)")
        if offline:
            continue
        first = pypi_first_release(name, fetch)
        if first is None:
            problems.append(f"{where}: '{name}' does not exist on PyPI (hallucinated or typo-squatted name?)")
        elif (now - first).days < MIN_AGE_DAYS:
            problems.append(f"{where}: '{name}' was first published {(now - first).days} days ago (< {MIN_AGE_DAYS})")

    approved_npm = {l.strip().lower() for l in (root / ".github" / "approved-dependencies.txt").read_text().splitlines()
                    if l.strip() and not l.startswith("#")} if (root / ".github" / "approved-dependencies.txt").exists() else set()
    problems += check_npm(root, approved_npm, offline, fetch, now)

    for wf in sorted((root / ".github" / "workflows").glob("*.yml")):
        problems += [f"action not pinned to a commit SHA: {b}" for b in unpinned_actions(wf)]
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="skip the PyPI and npm registry checks")
    problems = check(offline=parser.parse_args().offline)
    for p in problems:
        print(f"::error::{p}")
    print(f"dependency guard: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
