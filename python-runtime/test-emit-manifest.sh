#!/usr/bin/env bash
# Tests emit-manifest.py with a fake pip list: output matches tests/runtime-manifest.python-1.json on every
# key that file has, carries resolved versions, and a missing curated distribution is refused. No Docker needed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
expected="$root/tests/runtime-manifest.python-1.json"

fake='[
  {"name": "streamlit", "version": "1.45.1"}, {"name": "fastapi", "version": "0.115.12"},
  {"name": "uvicorn", "version": "0.34.3"},   {"name": "pandas", "version": "2.3.0"},
  {"name": "numpy", "version": "2.3.0"},      {"name": "plotly", "version": "6.1.2"},
  {"name": "altair", "version": "5.5.0"},     {"name": "pydantic", "version": "2.11.5"},
  {"name": "starlette", "version": "0.46.2"}, {"name": "click", "version": "8.1.8"},
  {"name": "Jinja2", "version": "3.1.6"},     {"name": "typing_extensions", "version": "4.13.2"},
  {"name": "pydantic_core", "version": "2.33.2"}, {"name": "pip", "version": "25.0.1"}
]'

out="$(printf '%s' "$fake" | python3 "$here/emit-manifest.py" --python 3.12)"
python3 - "$expected" <<PY
import json, sys
got = json.loads('''$out''')
exp = json.load(open(sys.argv[1]))
for key in exp:
    assert got[key] == exp[key], f"{key}: {got[key]!r} != {exp[key]!r}"
assert got["distributions"]["streamlit"] == "1.45.1"
assert set(got["distributions"]) == set(exp["modules"]), got["distributions"]
assert "click" not in got["modules"] and "jinja2" not in got["modules"], "transitive deps must not be allowed"
print("emit-manifest ok  matches", sys.argv[1], "+ distributions")
PY

# a curated distribution missing from the image is an error, not a shorter list
if printf '%s' "$fake" | python3 -c 'import json,sys; l=json.load(sys.stdin); print(json.dumps([p for p in l if p["name"]!="plotly"]))' \
   | python3 "$here/emit-manifest.py" >/dev/null 2>&1; then
  echo "emit-manifest FAIL: accepted a pip list without plotly"; exit 1
fi
echo "emit-manifest ok  refuses a missing curated distribution"

# garbage on stdin is an error
if echo 'not json' | python3 "$here/emit-manifest.py" >/dev/null 2>&1; then echo "emit-manifest FAIL: accepted non-JSON"; exit 1; fi
echo "emit-manifest ok  refuses non-JSON input"
