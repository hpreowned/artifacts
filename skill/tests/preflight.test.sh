#!/usr/bin/env bash
# Runs preflight.sh against every tests/corpus/* bundle and asserts:
#  - bundles whose expected.json lists a rule preflight covers exit 1 and print that rule id
#  - static-ok, static-fetch, static-navigate, python-ok exit 0
# Runs twice: with python3 on PATH and without (grep/sed fallback). Exit non-zero on any failure.
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

run_corpus with-python3
# Second pass: hide python3 so the grep/sed fallback is exercised.
NOPY=$(mktemp -d "${TMPDIR:-/tmp}/preflight-nopy.XXXXXX")
for t in bash grep sed find mktemp rm dirname basename tr sort; do ln -s "$(command -v $t)" "$NOPY/$t"; done
PATH="$NOPY" run_corpus no-python3
rm -rf "$NOPY"

echo "preflight.test.sh: $CASES cases, $( [ $FAIL = 0 ] && echo PASS || echo FAIL )"
exit $FAIL
