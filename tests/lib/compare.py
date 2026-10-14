#!/usr/bin/env python3
"""Compare one artifactctl `publish --json` result with a corpus expected.json. Standard library only.

Usage: compare.py <expected.json> < status.json
Prints one tab-separated line:  <ok|mismatch|error> <got state> <got rule ids, comma-joined or -> <detail>
Exit 0 on ok, 1 on mismatch, 2 when stdin is not a Status object.
"""
import json
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("error\t-\t-\tusage: compare.py <expected.json> < status.json")
        return 2
    with open(argv[1], encoding="utf-8") as f:
        expected = json.load(f)
    raw = sys.stdin.read()
    try:
        got = json.loads(raw)
        if not isinstance(got, dict) or "state" not in got:
            raise ValueError("not a Status object")
    except ValueError as e:
        print(f"error\t-\t-\tartifactctl printed no Status: {e}; output: {raw.strip()[:120]!r}")
        return 2
    state = got.get("state")
    findings = got.get("findings") or []
    rules = sorted({f.get("rule") for f in findings if isinstance(f, dict) and f.get("rule")})
    problems = []
    if state != expected["state"]:
        problems.append(f"state {state} != {expected['state']}")
    missing = [r for r in expected.get("rules", []) if r not in rules]
    if missing:
        problems.append("missing rules " + ",".join(missing))
    print("\t".join([
        "ok" if not problems else "mismatch",
        str(state),
        ",".join(rules) if rules else "-",
        "; ".join(problems) if problems else "",
    ]))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
