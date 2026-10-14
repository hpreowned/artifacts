#!/usr/bin/env bash
# Verifies the three app registrations from create.sh and prints the values to paste into the Claude
# connector dialog and the APIM named values. Exit 1 on any failed check. Needs: az (logged in), jq.
#   MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./verify.sh [--dry-run]
set -euo pipefail

MCP_URL="${MCP_URL:-https://mcp.corp.com/artifacts-mcp/mcp}"
SHELL_ORIGIN="${SHELL_ORIGIN:-https://artifacts.corp.com}"
MCP_APP_NAME="${MCP_APP_NAME:-artifacts-mcp}"
CONNECTOR_APP_NAME="${CONNECTOR_APP_NAME:-claude-connector}"
SHELL_APP_NAME="${SHELL_APP_NAME:-artifacts-viewer-shell}"
SCOPE_NAME="${SCOPE_NAME:-artifacts.publish}"
CLAUDE_REDIRECT="${CLAUDE_REDIRECT:-https://claude.ai/api/mcp/auth_callback}"
LOOPBACK_REDIRECT="${LOOPBACK_REDIRECT:-http://localhost}"

if [ "${1:-}" = "--dry-run" ]; then
  cat <<EOF
Dry run. Would check in the signed-in tenant:
  $MCP_APP_NAME        identifierUris == ["$MCP_URL"] byte for byte; api.requestedAccessTokenVersion == 2;
                       scope $SCOPE_NAME enabled, type User; service principal appRoleAssignmentRequired
  $CONNECTOR_APP_NAME  isFallbackPublicClient; publicClient.redirectUris ⊇ {$CLAUDE_REDIRECT, $LOOPBACK_REDIRECT};
                       no web redirects; no passwordCredentials; requiredResourceAccess -> $MCP_APP_NAME/$SCOPE_NAME;
                       admin consent grant (consentType AllPrincipals) present
  $SHELL_APP_NAME      web.redirectUris ∋ $SHELL_ORIGIN/auth/callback; a passwordCredential exists
Then print the connector dialog values and the APIM named values.
EOF
  exit 0
fi

fail=0
ok()   { printf 'ok    %-44s %s\n' "$1" "${2:-}"; }
bad()  { printf 'FAIL  %-44s %s\n' "$1" "${2:-}"; fail=1; }
warn() { printf 'warn  %-44s %s\n' "$1" "${2:-}"; }
check() { if [ "$1" = true ]; then ok "$2" "${3:-}"; else bad "$2" "${3:-}"; fi; }

app_json() { az ad app list --filter "displayName eq '$1'" --query '[0]' -o json; }
sp_id()    { az ad sp list --filter "appId eq '$1'" --query '[0].id' -o tsv; }
field()    { printf '%s' "$1" | jq -r "$2"; }

TENANT_ID="$(az account show --query tenantId -o tsv)"

# 1. resource app
MCP="$(app_json "$MCP_APP_NAME")"
[ "$MCP" != "null" ] || { bad "$MCP_APP_NAME exists"; echo "run create.sh first"; exit 1; }
MCP_APP_ID="$(field "$MCP" .appId)"
uri_count="$(field "$MCP" '.identifierUris | length')"
uri="$(field "$MCP" '.identifierUris[0] // ""')"
check "$([ "$uri_count" = 1 ] && echo true || echo false)" "$MCP_APP_NAME has exactly one App ID URI" "count=$uri_count"
if [ "$uri" = "$MCP_URL" ]; then
  ok "App ID URI == MCP URL (byte for byte)" "$uri"
else
  bad "App ID URI == MCP URL (byte for byte)" "$(printf 'entra=%q expected=%q' "$uri" "$MCP_URL")"
  case "$uri" in */) echo "      hint: trailing slash on the Entra side (DESIGN §9, AADSTS9010010)";; esac
fi
ver="$(field "$MCP" '.api.requestedAccessTokenVersion // "null"')"
check "$([ "$ver" = 2 ] && echo true || echo false)" "requestedAccessTokenVersion == 2" "got $ver"
SCOPE_ID="$(field "$MCP" ".api.oauth2PermissionScopes[] | select(.value==\"$SCOPE_NAME\" and .isEnabled==true and .type==\"User\") | .id")"
check "$([ -n "$SCOPE_ID" ] && echo true || echo false)" "scope $SCOPE_NAME enabled, type User" "$SCOPE_ID"
MCP_SP_ID="$(sp_id "$MCP_APP_ID")"
check "$([ -n "$MCP_SP_ID" ] && echo true || echo false)" "$MCP_APP_NAME service principal exists" "$MCP_SP_ID"
if [ -n "$MCP_SP_ID" ]; then
  req="$(az ad sp show --id "$MCP_SP_ID" --query appRoleAssignmentRequired -o tsv)"
  [ "$req" = "true" ] && ok "assignment required on $MCP_APP_NAME" || warn "assignment required on $MCP_APP_NAME" "false: any tenant user can obtain a token"
fi

# 2. connector app
CON="$(app_json "$CONNECTOR_APP_NAME")"
[ "$CON" != "null" ] || { bad "$CONNECTOR_APP_NAME exists"; exit 1; }
CONNECTOR_APP_ID="$(field "$CON" .appId)"
check "$(field "$CON" '.isFallbackPublicClient == true')" "isFallbackPublicClient"
check "$(field "$CON" ".publicClient.redirectUris | index(\"$CLAUDE_REDIRECT\") != null")" "public redirect $CLAUDE_REDIRECT"
check "$(field "$CON" ".publicClient.redirectUris | index(\"$LOOPBACK_REDIRECT\") != null")" "public redirect $LOOPBACK_REDIRECT (Claude Code)"
check "$(field "$CON" '(.web.redirectUris // []) | length == 0')" "no Web-platform redirects (would require a secret)"
check "$(field "$CON" '(.passwordCredentials // []) | length == 0')" "no client secret on the public client"
check "$(field "$CON" "[.requiredResourceAccess[] | select(.resourceAppId==\"$MCP_APP_ID\") | .resourceAccess[] | select(.id==\"$SCOPE_ID\" and .type==\"Scope\")] | length == 1")" \
  "permission $MCP_APP_NAME/$SCOPE_NAME requested"
grants="$(az ad app permission list-grants --id "$CONNECTOR_APP_ID" -o json 2>/dev/null || echo '[]')"
consented="$(printf '%s' "$grants" | jq -r "[.[] | select(.resourceId==\"$MCP_SP_ID\" and .consentType==\"AllPrincipals\" and (.scope | split(\" \") | index(\"$SCOPE_NAME\") != null))] | length > 0")"
check "$consented" "admin consent granted for $SCOPE_NAME" "(Enterprise apps > $CONNECTOR_APP_NAME > Permissions)"

# 3. shell app
SH="$(app_json "$SHELL_APP_NAME")"
[ "$SH" != "null" ] || { bad "$SHELL_APP_NAME exists"; exit 1; }
SHELL_APP_ID="$(field "$SH" .appId)"
check "$(field "$SH" ".web.redirectUris | index(\"$SHELL_ORIGIN/auth/callback\") != null")" "web redirect $SHELL_ORIGIN/auth/callback"
if [ "$(field "$SH" '(.passwordCredentials // []) | length > 0')" = true ]; then
  ok "shell client secret exists" "$(field "$SH" '.passwordCredentials[0].endDateTime') expiry"
else
  warn "shell client secret exists" "none yet: see README.md, store it as Key Vault secret entra-shell-client-secret"
fi

cat <<EOF

Connector dialog (Claude org settings > Connectors > Add custom connector, by an org Owner):
  URL ........................ $MCP_URL
  Authentication ............. Use your own OAuth client
  OAuth client ID ............ $CONNECTOR_APP_ID
  OAuth client secret ........ (leave empty)
  Settings are locked after adding: delete and re-add to change them.

APIM (infra/apim/apim.bicep parameters -> named values):
  tenantId / tenant-id ........................... $TENANT_ID
  artifactsMcpClientId / artifacts-mcp-client-id . $MCP_APP_ID
  claudeConnectorClientId / claude-connector-client-id  $CONNECTOR_APP_ID
  PRM "resource" and WWW-Authenticate resource_metadata host must use: $MCP_URL
  PRM "scopes_supported" entry: $MCP_URL/$SCOPE_NAME

Viewer shell (deploy/platform/viewer-shell.yaml env):
  AZURE_TENANT_ID=$TENANT_ID  AZURE_CLIENT_ID=$SHELL_APP_ID  redirect $SHELL_ORIGIN/auth/callback
EOF

[ "$fail" = 0 ] && echo "All checks passed." || { echo "Some checks FAILED."; exit 1; }
