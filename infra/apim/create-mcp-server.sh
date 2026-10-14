#!/usr/bin/env bash
# Fallback for the UNVERIFIED Bicep resource in apim.bicep: create the MCP server with the REST API
# directly, using the same body shape Microsoft's AI-Gateway sample sends. Run after the REST API
# "artifacts" exists. --dry-run prints the request without sending it.
#
#   SUBSCRIPTION_ID=<subscription-id> RESOURCE_GROUP=<apim-resource-group> APIM_NAME=<apim-name> \
#     ./create-mcp-server.sh [--dry-run]
set -euo pipefail

: "${SUBSCRIPTION_ID:?set SUBSCRIPTION_ID}"
: "${RESOURCE_GROUP:?set RESOURCE_GROUP}"
: "${APIM_NAME:?set APIM_NAME}"
REST_API_NAME="${REST_API_NAME:-artifacts}"
MCP_SERVER_NAME="${MCP_SERVER_NAME:-artifacts-mcp}"
API_VERSION="${API_VERSION:-2025-03-01-preview}"   # UNVERIFIED: the version the portal uses for MCP servers
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

apim_id="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}"
rest_api_id="${apim_id}/apis/${REST_API_NAME}"
url="https://management.azure.com${apim_id}/apis/${MCP_SERVER_NAME}?api-version=${API_VERSION}"

body=$(cat <<JSON
{
  "properties": {
    "displayName": "${MCP_SERVER_NAME}",
    "description": "Publish-to-AKS tools: beginPublish, getPublishStatus. Entra OAuth, scope artifacts.publish.",
    "type": "mcp",
    "path": "${MCP_SERVER_NAME}",
    "protocols": ["https"],
    "subscriptionRequired": false,
    "mcpTools": [
      {
        "name": "beginPublish",
        "operationId": "${rest_api_id}/operations/beginPublish",
        "description": "Start a publish job. Returns a one-time upload URL and token."
      },
      {
        "name": "getPublishStatus",
        "operationId": "${rest_api_id}/operations/getPublishStatus",
        "description": "Current state of a publish job, with findings or the live URL."
      }
    ]
  }
}
JSON
)

echo "PUT ${url}"
echo "${body}"
if $DRY_RUN; then
  echo "(dry run, nothing sent)"
  exit 0
fi
az rest --method put --url "${url}" --headers "Content-Type=application/json" --body "${body}"
echo
echo "MCP endpoint: https://<public-hostname>/${MCP_SERVER_NAME}/mcp  (apply the policy from policies/mcp-server.xml at this scope)"
