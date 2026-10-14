#!/usr/bin/env bash
# Tests upload.sh against skill/tests/fake-intake.py (python3 stdlib): success, 403 proxy, connection refused, bad token.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
UPLOAD="$ROOT/skill/publish-to-aks/scripts/upload.sh"
BUNDLE="$ROOT/tests/corpus/static-ok"
TOKEN="test-upload-token-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/upload-test.XXXXXX")
PIDS=""
cleanup() { [ -n "$PIDS" ] && kill $PIDS 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
FAIL=0
check() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: expected [$2] got [$1]"; FAIL=1; fi; }

start_fake() {  # start_fake <mode> -> prints port
  python3 "$HERE/fake-intake.py" "$TOKEN" "$WORK/received.zip" "$1" > "$WORK/port.$1" 2>/dev/null &
  PIDS="$PIDS $!"
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/port.$1" ] && break; sleep 0.2; done
  cat "$WORK/port.$1"
}

PORT=$(start_fake ok)
OUT=$(bash "$UPLOAD" "$BUNDLE" "http://127.0.0.1:$PORT/v1/publish/job_abcdefghij0123456789/upload" "$TOKEN" 2>"$WORK/err"); RC=$?
check "$RC" 0 "success exit code"
SHA=$(shasum -a 256 "$WORK/received.zip" | cut -c1-64)
check "$OUT" "UPLOADED job_abcdefghij0123456789 $SHA" "prints UPLOADED <jobId> <sha256 of the bytes the server received>"
LISTING=$(unzip -Z1 "$WORK/received.zip" | tr '\n' ' ')
check "$LISTING" "expected.json index.html manifest.json " "zip has files at the root in sorted order, no directories"

OUT=$(bash "$UPLOAD" "$BUNDLE" "http://127.0.0.1:$PORT/v1/publish/job_abcdefghij0123456789/upload" "wrong-token" 2>/dev/null); RC=$?
check "$RC" 1 "bad token is an API error (exit 1), not NETWORK_BLOCKED"

PORT2=$(start_fake forbidden)
OUT=$(bash "$UPLOAD" "$BUNDLE" "http://127.0.0.1:$PORT2/v1/publish/job_abcdefghij0123456789/upload" "$TOKEN" 2>/dev/null); RC=$?
check "$RC" 2 "HTTP 403 from a proxy exits 2"
check "$OUT" "NETWORK_BLOCKED" "HTTP 403 prints NETWORK_BLOCKED"

OUT=$(bash "$UPLOAD" "$BUNDLE" "http://127.0.0.1:9/v1/publish/job_abcdefghij0123456789/upload" "$TOKEN" 2>/dev/null); RC=$?
check "$RC" 2 "connection refused exits 2"
check "$OUT" "NETWORK_BLOCKED" "connection refused prints NETWORK_BLOCKED"

OUT=$(bash "$UPLOAD" "$BUNDLE" "http://127.0.0.1:$PORT/v1/publish/job_x" "$TOKEN" 2>/dev/null); RC=$?
check "$RC" 1 "uploadUrl without /upload suffix is a usage error"

mkdir -p "$WORK/link" && cp "$BUNDLE"/* "$WORK/link/" && ln -s index.html "$WORK/link/alias.html"
OUT=$(bash "$UPLOAD" "$WORK/link" "http://127.0.0.1:$PORT/v1/publish/job_abcdefghij0123456789/upload" "$TOKEN" 2>/dev/null); RC=$?
check "$RC" 1 "symlink in the bundle is refused before any network call"

echo "upload.test.sh: $( [ $FAIL = 0 ] && echo PASS || echo FAIL )"
exit $FAIL
