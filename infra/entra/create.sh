#!/usr/bin/env bash
# Entra app registrations for Publish-to-AKS, DESIGN.md §6.10. Idempotent: re-running updates in place.
#
#   1. artifacts-mcp            the resource. Application ID URI == MCP URL byte for byte,
#                               delegated scope artifacts.publish, v2 access tokens, assignment required.
#   2. claude-connector         public client, no secret. Redirects: the Claude.ai callback and the
#                               http://localhost loopback for Claude Code. Permission artifacts-mcp/artifacts.publish.
#   3. artifacts-viewer-shell   confidential web app for the viewer shell (MSAL auth-code + client secret).
#
# Usage:
#   MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./create.sh [--dry-run]
#
# Every tenant-specific value is an environment variable (README.md). --dry-run prints every command and
# sends nothing; it needs no login. Real runs need: az >= 2.60 logged in as an Application Administrator,
# and the host of MCP_URL verified as a domain in the tenant. This script never creates or prints a secret.
set -euo pipefail

MCP_URL="${MCP_URL:-https://mcp.corp.com/artifacts-mcp/mcp}"
SHELL_ORIGIN="${SHELL_ORIGIN:-https://artifacts.corp.com}"
MCP_APP_NAME="${MCP_APP_NAME:-artifacts-mcp}"
CONNECTOR_APP_NAME="${CONNECTOR_APP_NAME:-claude-connector}"
SHELL_APP_NAME="${SHELL_APP_NAME:-artifacts-viewer-shell}"
SCOPE_NAME="${SCOPE_NAME:-artifacts.publish}"
CLAUDE_REDIRECT="${CLAUDE_REDIRECT:-https://claude.ai/api/mcp/auth_callback}"
LOOPBACK_REDIRECT="${LOOPBACK_REDIRECT:-http://localhost}"
PUBLISHERS_GROUP_ID="${PUBLISHERS_GROUP_ID:-}"   # optional: object id of the Entra group allowed to publish
ADMIN_CONSENT="${ADMIN_CONSENT:-0}"              # 1 = grant admin consent for claude-connector (privileged role)
GRAPH="https://graph.microsoft.com/v1.0"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"   # Microsoft Graph's fixed first-party app id
DEFAULT_APP_ROLE="00000000-0000-0000-0000-000000000000" # Graph's "default access" app role id for group assignment

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

case "$MCP_URL" in
  */) echo "MCP_URL must not end with a slash; it must equal the connector URL byte for byte (AADSTS9010010)." >&2; exit 2 ;;
  https://*) ;;
  *) echo "MCP_URL must be https://" >&2; exit 2 ;;
esac

log() { printf '%s\n' "$*" >&2; }

# run <cmd...>: print the command; execute unless dry run.
run() { log "+ $*"; [ "$DRY_RUN" = 1 ] || "$@"; }

# query <placeholder> <cmd...>: like run, but a dry run prints the placeholder instead of calling az.
query() {
  local placeholder="$1"; shift
  log "+ $*"
  if [ "$DRY_RUN" = 1 ]; then printf '%s\n' "$placeholder"; else "$@"; fi
}

graph_patch() { # graph_patch <applications|servicePrincipals> <object-id> <json>
  log "+ az rest --method PATCH --url $GRAPH/$1/$2 --body '$3'"
  [ "$DRY_RUN" = 1 ] || az rest --method PATCH --url "$GRAPH/$1/$2" --headers Content-Type=application/json --body "$3"
}

new_uuid() {
  if command -v uuidgen >/dev/null; then uuidgen | tr 'A-Z' 'a-z'; else python3 -c 'import uuid; print(uuid.uuid4())'; fi
}

# ensure_app <display-name> [az ad app create args...]  -> sets APP_ID and OBJ_ID
ensure_app() {
  local name="$1"; shift
  local found=""
  if [ "$DRY_RUN" = 1 ]; then
    log "+ az ad app list --filter \"displayName eq '$name'\"   (dry run: assumed absent)"
  else
    found="$(az ad app list --filter "displayName eq '$name'" --query "[0].[appId,id]" -o tsv | tr '\t' ' ')"
  fi
  if [ -n "$found" ]; then
    APP_ID="${found%% *}"; OBJ_ID="${found##* }"
    log "= $name exists, appId=$APP_ID"
  else
    local created
    created="$(query "<${name}-app-id> <${name}-object-id>" \
      az ad app create --display-name "$name" --sign-in-audience AzureADMyOrg "$@" --query '[appId,id]' -o tsv | tr '\t' ' ')"
    APP_ID="${created%% *}"; OBJ_ID="${created##* }"
    log "= $name created, appId=$APP_ID"
  fi
}

# ensure_sp <app-id> -> prints the service principal object id
ensure_sp() {
  local sp
  sp="$(query "" az ad sp list --filter "appId eq '$1'" --query "[0].id" -o tsv)"
  [ -n "$sp" ] || sp="$(query "<sp-object-id-for-$1>" az ad sp create --id "$1" --query id -o tsv)"
  printf '%s\n' "$sp"
}

log "## 1/3 $MCP_APP_NAME (resource)"
ensure_app "$MCP_APP_NAME"
MCP_APP_ID="$APP_ID"; MCP_OBJ_ID="$OBJ_ID"
# The scope id must be stable across runs: reuse the existing one, mint one only the first time.
SCOPE_ID="$(query "" az ad app show --id "$MCP_APP_ID" --query "api.oauth2PermissionScopes[?value=='$SCOPE_NAME'].id | [0]" -o tsv)"
if [ -z "$SCOPE_ID" ]; then
  if [ "$DRY_RUN" = 1 ]; then SCOPE_ID="<new-scope-uuid>"; else SCOPE_ID="$(new_uuid)"; fi
fi
MCP_SP_ID="$(ensure_sp "$MCP_APP_ID")"

log "## 2/3 $CONNECTOR_APP_NAME (public client)"
ensure_app "$CONNECTOR_APP_NAME" --is-fallback-public-client true --public-client-redirect-uris "$CLAUDE_REDIRECT" "$LOOPBACK_REDIRECT"
CONNECTOR_APP_ID="$APP_ID"; CONNECTOR_OBJ_ID="$OBJ_ID"

# Resource app: URI, token version, scope, and pre-authorise the connector so consent is a one-time admin act.
graph_patch applications "$MCP_OBJ_ID" "$(cat <<JSON
{
  "identifierUris": ["$MCP_URL"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{
      "id": "$SCOPE_ID", "value": "$SCOPE_NAME", "type": "User", "isEnabled": true,
      "adminConsentDisplayName": "Publish artifacts",
      "adminConsentDescription": "Publish artifacts to the internal artifact platform on behalf of the signed-in user.",
      "userConsentDisplayName": "Publish artifacts",
      "userConsentDescription": "Publish artifacts to the internal artifact platform on your behalf."
    }],
    "preAuthorizedApplications": [{ "appId": "$CONNECTOR_APP_ID", "delegatedPermissionIds": ["$SCOPE_ID"] }]
  }
}
JSON
)"
# Assignment required on the resource: only assigned users/groups can obtain a token for it, whatever the client.
graph_patch servicePrincipals "$MCP_SP_ID" '{"appRoleAssignmentRequired": true}'
if [ -n "$PUBLISHERS_GROUP_ID" ]; then
  existing="$(query "" az rest --method GET --url "$GRAPH/servicePrincipals/$MCP_SP_ID/appRoleAssignedTo" \
    --query "value[?principalId=='$PUBLISHERS_GROUP_ID'].id | [0]" -o tsv)"
  if [ -z "$existing" ]; then
    run az rest --method POST --url "$GRAPH/servicePrincipals/$MCP_SP_ID/appRoleAssignedTo" --headers Content-Type=application/json \
      --body "{\"principalId\":\"$PUBLISHERS_GROUP_ID\",\"resourceId\":\"$MCP_SP_ID\",\"appRoleId\":\"$DEFAULT_APP_ROLE\"}"
  else
    log "= publishers group already assigned"
  fi
fi

# Connector app: enforce the public-client shape on every run (a Web redirect here would demand a secret).
graph_patch applications "$CONNECTOR_OBJ_ID" "$(cat <<JSON
{
  "isFallbackPublicClient": true,
  "publicClient": { "redirectUris": ["$CLAUDE_REDIRECT", "$LOOPBACK_REDIRECT"] },
  "web": { "redirectUris": [], "implicitGrantSettings": { "enableIdTokenIssuance": false, "enableAccessTokenIssuance": false } },
  "requiredResourceAccess": [{ "resourceAppId": "$MCP_APP_ID", "resourceAccess": [{ "id": "$SCOPE_ID", "type": "Scope" }] }]
}
JSON
)"
CONNECTOR_SP_ID="$(ensure_sp "$CONNECTOR_APP_ID")"
if [ "$ADMIN_CONSENT" = 1 ]; then
  run az ad app permission admin-consent --id "$CONNECTOR_APP_ID"
else
  log "= admin consent not granted (set ADMIN_CONSENT=1, or grant in the portal: Enterprise apps > $CONNECTOR_APP_NAME > Permissions)"
fi

log "## 3/3 $SHELL_APP_NAME (confidential web app)"
ensure_app "$SHELL_APP_NAME" --web-redirect-uris "${SHELL_ORIGIN}/auth/callback"
SHELL_APP_ID="$APP_ID"; SHELL_OBJ_ID="$OBJ_ID"
# openid + profile delegated permissions on Microsoft Graph, ids resolved from the tenant, nothing hardcoded.
OPENID_ID="$(query "<graph-openid-scope-id>" az ad sp show --id "$GRAPH_APP_ID" --query "oauth2PermissionScopes[?value=='openid'].id | [0]" -o tsv)"
PROFILE_ID="$(query "<graph-profile-scope-id>" az ad sp show --id "$GRAPH_APP_ID" --query "oauth2PermissionScopes[?value=='profile'].id | [0]" -o tsv)"
graph_patch applications "$SHELL_OBJ_ID" "$(cat <<JSON
{
  "web": {
    "redirectUris": ["${SHELL_ORIGIN}/auth/callback"],
    "implicitGrantSettings": { "enableIdTokenIssuance": false, "enableAccessTokenIssuance": false }
  },
  "requiredResourceAccess": [{ "resourceAppId": "$GRAPH_APP_ID",
    "resourceAccess": [{ "id": "$OPENID_ID", "type": "Scope" }, { "id": "$PROFILE_ID", "type": "Scope" }] }]
}
JSON
)"
SHELL_SP_ID="$(ensure_sp "$SHELL_APP_ID")"

cat <<EOF

Done. Values (also printed by verify.sh):
  Application ID URI / connector URL / PRM resource : $MCP_URL
  scopes_supported entry                            : $MCP_URL/$SCOPE_NAME
  APIM named value artifacts-mcp-client-id          : $MCP_APP_ID
  APIM named value claude-connector-client-id       : $CONNECTOR_APP_ID
  Viewer shell client id (AZURE_CLIENT_ID)          : $SHELL_APP_ID
  Service principals                                : mcp=$MCP_SP_ID connector=$CONNECTOR_SP_ID shell=$SHELL_SP_ID

Next (by a person, never by this script):
  1. Shell client secret straight into Key Vault, never on screen or disk:
       s=\$(az ad app credential reset --id $SHELL_APP_ID --display-name shell --years 1 --query password -o tsv)
       az keyvault secret set --vault-name <keyvault-name> --name entra-shell-client-secret --value "\$s" >/dev/null; unset s
  2. Admin consent for $CONNECTOR_APP_NAME if not granted above.
  3. Assign the publishers group to $MCP_APP_NAME (PUBLISHERS_GROUP_ID) and create group artifacts-approvers (README.md).
EOF
