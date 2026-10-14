#!/usr/bin/env python3
"""Validate dist/manifest.json against reference/manifest-schema.json without third-party libraries.

Prints `error: <message>` lines for every problem (exit 1), then `tier=`, `entrypoint=` and one
`externalScript=<url>` line per entry so preflight.sh can reuse the parsed values.
"""
import json
import re
import sys

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,62}$")
CDN_RE = re.compile(r"^https://(cdnjs\.cloudflare\.com/ajax/libs/|cdn\.jsdelivr\.net/npm/)[^\s\"'<>]+$")
TOP_KEYS = {"schemaVersion", "name", "tier", "runtime", "entrypoint", "externalScripts", "ttlDays", "generatedBy"}
REQUIRED = ["schemaVersion", "name", "tier", "entrypoint", "ttlDays", "generatedBy"]
TOOLS = {"cowork", "claude-code", "artifactctl", "other"}


def validate(m: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(m, dict):
        return ["manifest must be a JSON object"]
    for k in REQUIRED:
        if k not in m:
            errors.append(f"missing required field '{k}'")
    for k in m:
        if k not in TOP_KEYS:
            errors.append(f"unknown field '{k}'")
    if m.get("schemaVersion") != 2 or isinstance(m.get("schemaVersion"), bool):
        errors.append("schemaVersion must be 2")
    name = m.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        errors.append("name must match ^[a-z0-9][a-z0-9-]{2,62}$")
    tier = m.get("tier")
    if tier not in ("static", "python"):
        errors.append("tier must be 'static' or 'python'")
    runtime = m.get("runtime")
    if runtime not in ("python-1", None):
        errors.append("runtime must be 'python-1' or null")
    entry = m.get("entrypoint")
    if entry not in ("index.html", "app.py"):
        errors.append("entrypoint must be 'index.html' or 'app.py'")
    ext = m.get("externalScripts", [])
    if not isinstance(ext, list) or len(ext) > 20:
        errors.append("externalScripts must be an array of at most 20 URLs")
    else:
        for u in ext:
            if not isinstance(u, str) or not CDN_RE.match(u):
                errors.append(f"externalScripts entry is not on an allowlisted CDN: {u!r}")
    ttl = m.get("ttlDays")
    if isinstance(ttl, bool) or not isinstance(ttl, int) or not 1 <= ttl <= 90:
        errors.append("ttlDays must be an integer from 1 to 90")
    gb = m.get("generatedBy")
    if not isinstance(gb, dict) or gb.get("tool") not in TOOLS:
        errors.append("generatedBy.tool must be one of cowork, claude-code, artifactctl, other")
    else:
        for k in gb:
            if k not in ("tool", "model", "session"):
                errors.append(f"unknown generatedBy field '{k}'")
    if tier == "python":
        if runtime != "python-1":
            errors.append("tier python requires runtime 'python-1'")
        if entry != "app.py":
            errors.append("tier python requires entrypoint 'app.py'")
    if tier == "static":
        if runtime is not None:
            errors.append("tier static requires runtime null")
        if entry != "index.html":
            errors.append("tier static requires entrypoint 'index.html'")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: preflight-manifest.py <manifest.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        print(f"error: manifest.json is not valid JSON: {e}")
        return 1
    errors = validate(m)
    for e in errors:
        print(f"error: {e}")
    if isinstance(m, dict):
        if m.get("tier") in ("static", "python"):
            print(f"tier={m['tier']}")
        if m.get("entrypoint") in ("index.html", "app.py"):
            print(f"entrypoint={m['entrypoint']}")
        for u in m.get("externalScripts", []) if isinstance(m.get("externalScripts"), list) else []:
            if isinstance(u, str):
                print(f"externalScript={u}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
