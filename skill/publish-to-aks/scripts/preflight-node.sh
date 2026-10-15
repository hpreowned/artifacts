#!/usr/bin/env bash
# Sourced by preflight.sh: node-tier checks (JS-001, JS-002, JS-005, JS-006; JS-003/JS-004 fire from
# check_files in preflight.sh itself, since they are filename/path checks, not file-content checks).
# Not a security control: the pipeline's own JS checks (contracts/findings.md) are the real gate, plus
# ephemerality, egress denial and the human approval (DESIGN §6.13). Expects: finding, flag_lines, PY
# from the caller (preflight.sh).

# check_prototype_bundle: JS-002 (missing lockfile), JS-006 (no start script, or a lifecycle script present).
check_prototype_bundle() {
  if [ ! -f package.json ]; then
    finding JS-006 deny package.json 0 "package.json is missing; a node bundle's entrypoint is package.json"
  elif [ -n "$PY" ]; then
    local out
    out=$($PY - package.json <<'PYEOF' 2>&1
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        pkg = json.load(f)
except Exception as e:
    print(f"error: package.json is not valid JSON: {e}")
    sys.exit(0)
if not isinstance(pkg, dict):
    print("error: package.json is not a JSON object")
    sys.exit(0)
scripts = pkg.get("scripts")
scripts = scripts if isinstance(scripts, dict) else {}
start = scripts.get("start")
if not isinstance(start, str) or not start.strip():
    print('error: package.json has no "start" script (it must serve everything on $PORT)')
for name in ("preinstall", "postinstall", "prepare"):
    if name in scripts:
        print(f'error: package.json defines a "{name}" lifecycle script, which is not allowed (the pipeline installs with npm ci --ignore-scripts)')
PYEOF
)
    printf '%s\n' "$out" | sed -n 's/^error: //p' | while IFS= read -r line; do
      finding JS-006 deny package.json 0 "$line"
    done
  else
    grep -qE '"start"[[:space:]]*:' package.json || finding JS-006 deny package.json 0 'package.json has no "start" script (it must serve everything on $PORT)'
    local name
    for name in preinstall postinstall prepare; do
      grep -qE "\"$name\"[[:space:]]*:" package.json && finding JS-006 deny package.json 0 "package.json defines a \"$name\" lifecycle script, which is not allowed (the pipeline installs with npm ci --ignore-scripts)"
    done
  fi
  [ -f package-lock.json ] || finding JS-002 deny package-lock.json 0 "package-lock.json is missing; the pipeline installs with npm ci and needs a lockfile"
}

# check_prototype_js_file FILE: JS-001 (forbidden server-side modules/sockets) and JS-005 (warn: eval/Function,
# non-relative fetch/http.request -- egress is denied at run time, this is reported so authors learn).
check_prototype_js_file() {
  local f=$1
  flag_lines JS-001 deny "$f" '(^|[^A-Za-z0-9_."'"'"'])require[[:space:]]*\([[:space:]]*["'"'"'](child_process|node:child_process|vm|node:vm|worker_threads|node:worker_threads|cluster|node:cluster)["'"'"']' "forbidden module: child_process, vm, worker_threads and cluster are not allowed in the bundle's own server files"
  flag_lines JS-001 deny "$f" 'from[[:space:]]+["'"'"'](child_process|node:child_process|vm|node:vm|worker_threads|node:worker_threads|cluster|node:cluster)["'"'"']' "forbidden import: child_process, vm, worker_threads and cluster are not allowed"
  flag_lines JS-001 deny "$f" '(^|[^A-Za-z0-9_.$])(net|dgram|tls)\.(createServer|connect|createConnection|Socket)[[:space:]]*\(' "forbidden raw socket creation (net/dgram/tls)"
  flag_lines JS-001 deny "$f" 'process\.binding[[:space:]]*\(' "forbidden call: process.binding("
  flag_lines JS-005 warn "$f" '(^|[^A-Za-z0-9_.$])eval[[:space:]]*\(|new[[:space:]]+Function[[:space:]]*\(' "(warn) eval( or new Function( — egress is denied at run time regardless, but this is noted for the author"
  flag_lines JS-005 warn "$f" '(^|[^A-Za-z0-9_.$])fetch[[:space:]]*\([[:space:]]*["'"'"']https?://|http\.request[[:space:]]*\([[:space:]]*["'"'"']https?://|https\.request[[:space:]]*\([[:space:]]*["'"'"']https?://' "(warn) outbound HTTP to a non-relative URL; egress is denied at run time"
}
