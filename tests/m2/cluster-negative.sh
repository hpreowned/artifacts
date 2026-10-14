#!/usr/bin/env bash
# tests/m2/cluster-negative.sh [--api-url <url>] [tests/negative.sh args...]
#
# Wraps tests/negative.sh for the AKS cluster (docs/M2-RUNBOOK.md step 27). Gets a real Entra access
# token for the artifacts-mcp resource and decodes its oid/upn claims, so the test runs as a real
# identity. T18 resolved this script's former "Known gap" (docs/M2-RUNBOOK.md): intake-api now verifies
# this token itself (intake-api/src/entra-token.ts) even though this script talks to it directly,
# bypassing APIM's validate-azure-ad-token policy entirely (M2 is internal-only; APIM fronts this route
# only from M3 on) -- so this is now a real, not simulated, auth check. The --resource value below is
# the artifacts-mcp Application ID URI; its app registration's requestedAccessTokenVersion: 2 means the
# token's aud claim is the client id regardless of which endpoint issued it, which is what intake-api's
# ENTRA_AUDIENCE checks (DESIGN §6.10, infra/entra/README.md) -- no --scope/.default form is needed.
# ARTIFACTS_DEV_OID (decoded below, for the audit trail only) is sent as X-Publisher-Oid/-Upn, which
# intake-api no longer reads unless DEV_AUTH=1 (not set in deploy/platform/intake-api.yaml); ARTIFACTS_TOKEN
# is what actually authenticates beginPublish/getPublishStatus now.
#
# Targets the in-cluster intake URL via a kubectl port-forward by default, or any URL already in
# ARTIFACTS_API_URL / --api-url (e.g. the Gateway's internal "intake" listener, from inside the VNet:
# http://intake.artifacts.internal:8080).
#
# Usage:
#   tests/m2/cluster-negative.sh                        # port-forward to intake-api, run the full corpus
#   tests/m2/cluster-negative.sh --only static-ok        # extra args pass straight through to negative.sh
#   ARTIFACTS_API_URL=http://intake.artifacts.internal:8080 tests/m2/cluster-negative.sh --dry-run
#
# Environment:
#   ARTIFACTS_API_URL       Skip the port-forward and use this URL directly. Default: start one.
#   ARTIFACTS_MCP_RESOURCE  Resource/App ID URI for `az account get-access-token`.
#                           Default: https://mcp.corp.com/artifacts-mcp/mcp
#   NAMESPACE               Namespace to port-forward into. Default: artifacts-system
#   INTAKE_DEPLOYMENT       Deployment to port-forward to. Default: intake-api
#   LOCAL_PORT              Local port for the port-forward. Default: 18080
#   REMOTE_PORT             Remote port on intake-api. Default: 8080
#
# Needs: az (logged in as a user who can get a token for ARTIFACTS_MCP_RESOURCE), kubectl (pointed at
# the right context, unless ARTIFACTS_API_URL is set), python3, and everything tests/negative.sh needs
# (node, artifactctl built: npm --prefix cli ci && npm --prefix cli run build).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

NAMESPACE="${NAMESPACE:-artifacts-system}"
INTAKE_DEPLOYMENT="${INTAKE_DEPLOYMENT:-intake-api}"
LOCAL_PORT="${LOCAL_PORT:-18080}"
REMOTE_PORT="${REMOTE_PORT:-8080}"
ARTIFACTS_MCP_RESOURCE="${ARTIFACTS_MCP_RESOURCE:-https://mcp.corp.com/artifacts-mcp/mcp}"
API_URL="${ARTIFACTS_API_URL:-}"

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) shift; [ $# -gt 0 ] || usage; API_URL="$1" ;;
    -h|--help) usage ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

command -v az >/dev/null 2>&1 || { echo "az CLI is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

PF_PID=""
cleanup() { [ -z "$PF_PID" ] || kill "$PF_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [ -z "$API_URL" ]; then
  command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required unless ARTIFACTS_API_URL is set" >&2; exit 1; }
  echo "port-forwarding $NAMESPACE/$INTAKE_DEPLOYMENT $LOCAL_PORT:$REMOTE_PORT" >&2
  kubectl -n "$NAMESPACE" port-forward "deploy/$INTAKE_DEPLOYMENT" "$LOCAL_PORT:$REMOTE_PORT" >/dev/null 2>&1 &
  PF_PID=$!
  up=0
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$LOCAL_PORT/healthz"; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || { echo "intake-api never answered /healthz through the port-forward" >&2; exit 2; }
  API_URL="http://localhost:$LOCAL_PORT"
fi

echo "getting an Entra access token for $ARTIFACTS_MCP_RESOURCE" >&2
TOKEN="$(az account get-access-token --resource "$ARTIFACTS_MCP_RESOURCE" --query accessToken -o tsv)"
[ -n "$TOKEN" ] || { echo "az account get-access-token returned nothing; az login first" >&2; exit 1; }

# Decode the oid/upn claims (stdlib only, no jq dependency). Never print the token itself.
read -r OID UPN < <(python3 -c '
import sys, base64, json
tok = sys.argv[1]
payload = tok.split(".")[1]
payload += "=" * (-len(payload) % 4)
data = json.loads(base64.urlsafe_b64decode(payload))
print(data.get("oid", "unknown-oid"), data.get("upn") or data.get("preferred_username") or data.get("unique_name") or "unknown-upn")
' "$TOKEN")

echo "token decoded: oid=$OID upn=$UPN" >&2
echo "note: intake-api verifies this Entra token itself now (T18); X-Publisher-Oid/-Upn are sent for the audit trail only and are not read unless DEV_AUTH=1" >&2

export ARTIFACTS_API_URL="$API_URL"
export ARTIFACTS_TOKEN="$TOKEN"
export ARTIFACTS_DEV_OID="$OID"

echo "running tests/negative.sh against $API_URL as oid=$OID" >&2
set +e
"$ROOT/tests/negative.sh" "${ARGS[@]}"
RC=$?
set -e

SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ $RC -eq 0 ]; then
  echo "M2 cluster corpus: all bundles ok (tests/negative.sh against $API_URL, commit $SHA)"
else
  echo "M2 cluster corpus: FAILED, exit $RC (tests/negative.sh against $API_URL, commit $SHA) -- see table above"
fi
exit $RC
