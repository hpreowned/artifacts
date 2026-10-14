#!/usr/bin/env bash
# tests/negative.sh [--dry-run] [--only <name>] [--interval <s>] [--timeout <s>]
# Publishes every tests/corpus/<name>/ through artifactctl against ARTIFACTS_API_URL (publish --wait --json),
# compares `state` with expected.json and asserts every id in expected.json `rules` appears in the findings.
# Prints a table; exits 0 when every bundle matches, 1 on any mismatch, 2 when the API is unreachable.
#
# Environment (all passed through to artifactctl, see cli/README.md):
#   ARTIFACTS_API_URL   intake base URL (default http://localhost:8080)
#   ARTIFACTS_TOKEN     bearer; not needed when ARTIFACTS_DEV_OID is set
#   ARTIFACTS_DEV_OID   local dev stack identity, e.g. dev-user
#   ARTIFACTCTL         command to run instead of `node <repo>/cli/dist/artifactctl.js` (optional)
# Needs bash, node (for artifactctl) and python3 (tests/lib/compare.py).
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
CORPUS="$HERE/corpus"
COMPARE="$HERE/lib/compare.py"
DRY=0; ONLY=""; INTERVAL=2; TIMEOUT=600

usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) shift; [ $# -gt 0 ] || usage; ONLY=$1 ;;
    --interval) shift; [ $# -gt 0 ] || usage; INTERVAL=$1 ;;
    --timeout) shift; [ $# -gt 0 ] || usage; TIMEOUT=$1 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
  shift
done

# ---------- locate artifactctl ----------
if [ -n "${ARTIFACTCTL:-}" ]; then
  read -r -a CLI <<< "$ARTIFACTCTL"
elif [ -f "$ROOT/cli/dist/artifactctl.js" ]; then
  CLI=(node "$ROOT/cli/dist/artifactctl.js")
elif command -v artifactctl >/dev/null 2>&1; then
  CLI=(artifactctl)
else
  echo "artifactctl not found: run 'npm --prefix $ROOT/cli ci && npm --prefix $ROOT/cli run build' or set ARTIFACTCTL" >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for $COMPARE" >&2; exit 1; }

# ---------- bundles ----------
BUNDLES=()
for dir in "$CORPUS"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/expected.json" ] || continue
  [ -z "$ONLY" ] || [ "$name" = "$ONLY" ] || continue
  BUNDLES+=("$name")
done
[ ${#BUNDLES[@]} -gt 0 ] || { echo "no bundle named '$ONLY' in $CORPUS" >&2; exit 1; }

expected_of() {  # expected_of <name> -> "<state> <rules,comma or ->"
  python3 -c 'import json,sys; e=json.load(open(sys.argv[1])); print(e["state"], ",".join(e.get("rules",[])) or "-")' "$CORPUS/$1/expected.json"
}

FMT='%-26s %-18s %-18s %-22s %s\n'
API=${ARTIFACTS_API_URL:-http://localhost:8080}
if [ $DRY = 1 ]; then
  echo "dry run: would publish ${#BUNDLES[@]} bundle(s) to $API with: ${CLI[*]} publish --wait --json --interval $INTERVAL --timeout $TIMEOUT <dir>"
  printf "$FMT" bundle "expected state" "expected rules" "" ""
  for name in "${BUNDLES[@]}"; do
    read -r state rules <<< "$(expected_of "$name")"
    printf "$FMT" "$name" "$state" "$rules" "" ""
  done
  exit 0
fi

echo "publishing ${#BUNDLES[@]} bundle(s) to $API"
printf "$FMT" bundle expected got "got rules" result
FAIL=0; OK=0
for name in "${BUNDLES[@]}"; do
  read -r want_state want_rules <<< "$(expected_of "$name")"
  ERR=$(mktemp "${TMPDIR:-/tmp}/negative.XXXXXX")
  OUT=$("${CLI[@]}" publish --wait --json --interval "$INTERVAL" --timeout "$TIMEOUT" "$CORPUS/$name" 2>"$ERR"); RC=$?
  if [ $RC -eq 2 ]; then
    printf "$FMT" "$name" "$want_state" "-" "-" "NETWORK ERROR"
    cat "$ERR" >&2; rm -f "$ERR"
    echo "negative.sh: $API unreachable; aborting" >&2
    exit 2
  fi
  LINE=$(printf '%s' "$OUT" | python3 "$COMPARE" "$CORPUS/$name/expected.json"); CRC=$?
  IFS=$'\t' read -r result got_state got_rules detail <<< "$LINE"
  if [ $CRC -eq 0 ]; then
    OK=$((OK + 1)); printf "$FMT" "$name" "$want_state" "$got_state" "$got_rules" "ok"
  else
    FAIL=$((FAIL + 1)); printf "$FMT" "$name" "$want_state" "$got_state" "$got_rules" "MISMATCH: $detail (artifactctl exit $RC)"
    [ -s "$ERR" ] && sed 's/^/    stderr: /' "$ERR"
  fi
  rm -f "$ERR"
done
echo "negative.sh: $OK ok, $FAIL mismatch, ${#BUNDLES[@]} total"
[ $FAIL -eq 0 ]
