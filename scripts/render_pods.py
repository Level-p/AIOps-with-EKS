#!/usr/bin/env python3
"""Turn rendered Helm output into the Pods the cluster would create, for `kyverno apply` in CI.

The Kyverno policies match Pods (as the admission controller sees them). The CLI
does not expand Deployments/CronJobs into Pods by itself, so this script does:
it reads multi-document YAML on stdin, extracts every pod template, and writes
Pod manifests (with the namespace set) to stdout.

Usage: helm template ... | python scripts/render_pods.py <namespace> > pods.yaml
"""

import sys

import yaml


def pod_spec(doc: dict):
    kind, spec = doc.get("kind"), doc.get("spec") or {}
    if kind == "Pod":
        return doc.get("metadata", {}), spec
    if kind in ("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"):
        tpl = spec.get("template") or {}
        return tpl.get("metadata", {}), tpl.get("spec")
    if kind == "CronJob":
        tpl = ((spec.get("jobTemplate") or {}).get("spec") or {}).get("template") or {}
        return tpl.get("metadata", {}), tpl.get("spec")
    return None, None


def to_pods(docs, namespace: str):
    pods = []
    for doc in docs:
        if not doc:
            continue
        meta, spec = pod_spec(doc)
        if spec is None:
            continue
        pods.append({"apiVersion": "v1", "kind": "Pod",
                     "metadata": {"name": f'{doc["kind"].lower()}-{doc["metadata"]["name"]}', "namespace": namespace,
                                  "labels": (meta or {}).get("labels", {})},
                     "spec": spec})
    return pods


if __name__ == "__main__":
    pods = to_pods(yaml.safe_load_all(sys.stdin), sys.argv[1])
    print(f"{len(pods)} pod(s) for {sys.argv[1]}", file=sys.stderr)
    yaml.safe_dump_all(pods, sys.stdout, sort_keys=False)
