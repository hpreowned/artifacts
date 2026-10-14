#!/usr/bin/env bash
# Proves tests/negative.sh works without the real intake: runs it against cli/test/corpus-fake.ts, a fake intake
# whose verdicts come from the corpus expected.json files. Exercises: --dry-run, the full run (all ok), --only,
# a forced mismatch (exit 1), and an unreachable API (exit 2). Needs node and python3; no network.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
NEG="$ROOT/tests/negative.sh"
FAKE="$ROOT/cli/.tsbuild/test/corpus-fake.js"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/negative-selftest.XXXXXX")
PIDS=""
cleanup() { [ -n "$PIDS" ] && kill $PIDS 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
FAIL=0
check() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: expected [$2] got [$1]"; FAIL=1; fi; }
contains() { if printf '%s\n' "$1" | grep -qE "$2"; then echo "ok   $3"; else echo "FAIL $3: pattern [$2] not in output"; printf '%s\n' "$1" | sed 's/^/     | /'; FAIL=1; fi; }

if [ ! -f "$FAKE" ] || [ ! -f "$ROOT/cli/dist/artifactctl.js" ]; then
  (cd "$ROOT/cli" && npm run build >/dev/null && npm run build:test >/dev/null) || { echo "build failed" >&2; exit 1; }
fi

start_fake() {  # start_fake <logfile> [env assignments...] -> prints base URL
  local log=$1; shift
  env "$@" node "$FAKE" > "$log" 2>&1 &
  PIDS="$PIDS $!"
  for _ in $(seq 1 50); do grep -q '^http' "$log" 2>/dev/null && break; sleep 0.1; done
  head -1 "$log"
}
BASE=$(start_fake "$WORK/fake.log")
[ -n "$BASE" ] || { echo "corpus-fake did not start:"; cat "$WORK/fake.log"; exit 1; }
TOTAL=$(find "$ROOT/tests/corpus" -mindepth 2 -maxdepth 2 -name expected.json | wc -l | tr -d ' ')

OUT=$(bash "$NEG" --dry-run 2>&1); RC=$?
check "$RC" 0 "--dry-run exits 0"
contains "$OUT" "^dry run: would publish $TOTAL bundle" "--dry-run lists every bundle"
contains "$OUT" "^static-injection +rejected +HTML-002,HTML-005" "--dry-run shows expected state and rules"

OUT=$(ARTIFACTS_API_URL="$BASE" ARTIFACTS_DEV_OID=dev-user bash "$NEG" --interval 0 2>&1); RC=$?
check "$RC" 0 "full run against the corpus fake exits 0"
contains "$OUT" "^negative.sh: $TOTAL ok, 0 mismatch, $TOTAL total$" "every bundle matched"
contains "$OUT" "^static-bad-manifest +rejected +rejected +IN-006 +ok$" "400 at beginPublish counts as rejected IN-006"
contains "$OUT" "^python-ok +awaiting_approval +awaiting_approval +- +ok$" "python bundle stops at awaiting_approval"

OUT=$(ARTIFACTS_API_URL="$BASE" ARTIFACTS_DEV_OID=dev-user bash "$NEG" --interval 0 --only static-ok 2>&1); RC=$?
check "$RC" 0 "--only static-ok exits 0"
contains "$OUT" "^negative.sh: 1 ok, 0 mismatch, 1 total$" "--only runs one bundle"

OUT=$(bash "$NEG" --only no-such-bundle 2>&1); RC=$?
check "$RC" 1 "--only with an unknown name exits 1"

BAD=$(start_fake "$WORK/bad.log" CORPUS_FAKE_FORCE_STATE=failed)
OUT=$(ARTIFACTS_API_URL="$BAD" ARTIFACTS_DEV_OID=dev-user bash "$NEG" --interval 0 --only static-ok 2>&1); RC=$?
check "$RC" 1 "a wrong state exits 1"
contains "$OUT" "^static-ok +live +failed +- +MISMATCH: state failed != live" "mismatch row names the states"

OUT=$(ARTIFACTS_API_URL="http://127.0.0.1:9" ARTIFACTS_DEV_OID=dev-user bash "$NEG" --only static-ok 2>&1); RC=$?
check "$RC" 2 "unreachable API exits 2"
contains "$OUT" "NETWORK ERROR" "unreachable API is reported as such"

OUT=$(ARTIFACTS_API_URL="$BASE" bash "$NEG" --only static-ok 2>&1); RC=$?
check "$RC" 1 "missing ARTIFACTS_TOKEN and ARTIFACTS_DEV_OID is a mismatch row, not a crash"
contains "$OUT" "ARTIFACTS_TOKEN" "the artifactctl error is shown under the row"

echo "selftest.sh: $( [ $FAIL = 0 ] && echo PASS || echo FAIL )"
exit $FAIL
