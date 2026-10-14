#!/usr/bin/env bash
# tests/m2/smoke.sh
#
# Post-deploy smoke test for the M2 static tier (docs/M2-RUNBOOK.md step 26). Health-checks the four
# platform services, publishes tests/corpus/static-ok, and walks the static-gateway's token -> cookie
# -> CSP-header handshake by calling intake-api's internal /v1/view-token route directly (the same call
# viewer-shell makes internally, with X-Internal-Caller: INTERNAL_SHARED_KEY) -- this script never
# drives a browser or an Entra sign-in, so it cannot walk the shell page itself. That full walk,
# including the real sign-in and the frame-src/connect-src browser checks, is
# tests/m2/browser-checklist.md (docs/M2-RUNBOOK.md step 29).
#
# NOTE: static-gateway and scanner-worker do not yet implement GET /healthz (STATUS.md T16, T17, both
# "todo" as of this writing). Their health checks below will fail until those land; that is a known,
# tracked gap, not a bug in this script.
#
# Usage:
#   tests/m2/smoke.sh
#
# Environment:
#   NAMESPACE             Namespace intake-api/scanner-worker/viewer-shell live in. Default: artifacts-system
#   STATIC_NAMESPACE      Namespace static-gateway lives in. Default: artifacts-static
#   ARTIFACT_DOMAIN       Registrable domain of artifact origins. Default: corp-artifacts.net
#   SHELL_SECRET_NAME     Kubernetes Secret holding INTERNAL_SHARED_KEY. Default: viewer-shell-secrets
#   INTERNAL_SHARED_KEY   Skip reading the cluster Secret and use this value directly.
#   ARTIFACTS_DEV_OID     Identity artifactctl sends as X-Publisher-Oid (direct, non-APIM path, same as
#                          cluster-negative.sh). Default: smoke-test
#   ARTIFACTCTL            Command to run instead of `node <repo>/cli/dist/artifactctl.js` (optional).
#
# Needs: kubectl (pointed at the right context), node (artifactctl), python3, curl.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
case "${1:-}" in -h|--help) usage ;; esac

NAMESPACE="${NAMESPACE:-artifacts-system}"
STATIC_NAMESPACE="${STATIC_NAMESPACE:-artifacts-static}"
ARTIFACT_DOMAIN="${ARTIFACT_DOMAIN:-corp-artifacts.net}"
SHELL_SECRET_NAME="${SHELL_SECRET_NAME:-viewer-shell-secrets}"
ARTIFACTS_DEV_OID="${ARTIFACTS_DEV_OID:-smoke-test}"

INTAKE_PORT=18080 SCANNER_PORT=18081 GATEWAY_PORT=18082 SHELL_PORT=18083
PF_PIDS=()
cleanup() { for p in "${PF_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

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

FAIL=0
pf() { # pf <ns> <deploy/name> <local-port> <remote-port>
  kubectl -n "$1" port-forward "$2" "$3:$4" >/dev/null 2>&1 &
  PF_PIDS+=("$!")
}
wait_up() { # wait_up <url>
  for _ in $(seq 1 30); do curl -s -o /dev/null "$1" && return 0; sleep 1; done
  return 1
}
check() { # check <label> <url>
  if wait_up "$2"; then echo "ok    $1 ($2)"; else echo "FAIL  $1 ($2)"; FAIL=1; fi
}

echo "## health checks"
pf "$NAMESPACE" deploy/intake-api "$INTAKE_PORT" 8080
pf "$NAMESPACE" deploy/scanner-worker "$SCANNER_PORT" 8081
pf "$STATIC_NAMESPACE" deploy/static-gateway "$GATEWAY_PORT" 8080
pf "$NAMESPACE" deploy/viewer-shell "$SHELL_PORT" 8080
sleep 2
check intake-api        "http://localhost:$INTAKE_PORT/healthz"
check scanner-worker     "http://localhost:$SCANNER_PORT/healthz"
check static-gateway     "http://localhost:$GATEWAY_PORT/healthz"
check viewer-shell       "http://localhost:$SHELL_PORT/healthz"

echo "## publish tests/corpus/static-ok"
export ARTIFACTS_API_URL="http://localhost:$INTAKE_PORT"
export ARTIFACTS_DEV_OID
set +e
OUT="$("${CLI[@]}" publish --wait --json "$ROOT/tests/corpus/static-ok")"
PUBLISH_RC=$?
set -e
echo "$OUT"
[ -n "$OUT" ] || { echo "FAIL  publish produced no output (exit $PUBLISH_RC)"; exit 1; }

read -r STATE ARTIFACT_ID < <(python3 -c '
import json, sys
got = json.loads(sys.argv[1])
state = got.get("state", "")
url = got.get("url") or ""
artifact_id = url.rstrip("/").rsplit("/", 1)[-1] if url else ""
print(state, artifact_id)
' "$OUT")
if [ "$STATE" = live ] && [ -n "$ARTIFACT_ID" ]; then
  echo "ok    publish (state=live artifactId=$ARTIFACT_ID)"
else
  echo "FAIL  publish (state=$STATE)"; FAIL=1
fi

echo "## gateway token -> cookie -> CSP handshake"
if [ -n "${INTERNAL_SHARED_KEY:-}" ]; then
  KEY="$INTERNAL_SHARED_KEY"
else
  KEY="$(kubectl -n "$NAMESPACE" get secret "$SHELL_SECRET_NAME" -o jsonpath='{.data.INTERNAL_SHARED_KEY}' 2>/dev/null | base64 -d || true)"
fi
if [ -z "$KEY" ] || [ "$FAIL" = 1 ]; then
  echo "FAIL  no INTERNAL_SHARED_KEY available (secret $SHELL_SECRET_NAME in $NAMESPACE) or an earlier check failed; skipping the handshake"
  FAIL=1
else
  TOKEN_OUT="$(curl -s -X POST "http://localhost:$INTAKE_PORT/v1/view-token" \
    -H "X-Internal-Caller: $KEY" -H 'content-type: application/json' \
    -d "{\"artifactId\":\"$ARTIFACT_ID\",\"viewerOid\":\"smoke-test\"}")"
  TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("token",""))' "$TOKEN_OUT")"
  if [ -z "$TOKEN" ]; then
    echo "FAIL  /v1/view-token did not return a token: $TOKEN_OUT"; FAIL=1
  else
    echo "ok    minted a view token"
    SET_COOKIE="$(curl -si -H "Host: ${ARTIFACT_ID}.${ARTIFACT_DOMAIN}" "http://localhost:$GATEWAY_PORT/?t=${TOKEN}" | grep -i '^set-cookie:' | head -1)"
    COOKIE_PAIR="$(printf '%s' "$SET_COOKIE" | sed -E 's/^[Ss]et-[Cc]ookie: *([^;]+);.*/\1/' | tr -d '\r')"
    if [ -z "$COOKIE_PAIR" ]; then
      echo "FAIL  gateway did not set a session cookie for ?t=<token>"; FAIL=1
    else
      echo "ok    gateway issued $COOKIE_PAIR"
      PAGE="$(curl -si -H "Host: ${ARTIFACT_ID}.${ARTIFACT_DOMAIN}" -H "Cookie: ${COOKIE_PAIR}" "http://localhost:$GATEWAY_PORT/")"
      if printf '%s' "$PAGE" | head -1 | grep -q ' 200 ' && printf '%s' "$PAGE" | grep -qi '^content-security-policy:'; then
        echo "ok    GET with cookie -> 200 with Content-Security-Policy present"
      else
        echo "FAIL  GET with cookie did not return 200 with a Content-Security-Policy header"; FAIL=1
      fi
    fi
  fi
fi

if [ "$FAIL" = 0 ]; then echo "SMOKE: PASS"; else echo "SMOKE: FAIL"; fi
exit "$FAIL"
