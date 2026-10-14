# infra/entra — the Entra app registrations

Two registrations make the Claude connector work (DESIGN §6.10) and a third signs viewers into the shell.
`create.sh` creates or updates them idempotently; `verify.sh` checks every value that must match and prints
what to paste into the connector dialog. Both run with `--dry-run` without a tenant.

```
MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./create.sh --dry-run
MCP_URL=... SHELL_ORIGIN=... ADMIN_CONSENT=1 PUBLISHERS_GROUP_ID=<group-object-id> ./create.sh
MCP_URL=... SHELL_ORIGIN=... ./verify.sh
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MCP_URL` | `https://mcp.corp.com/artifacts-mcp/mcp` | the MCP endpoint as typed into the connector dialog. Becomes the Application ID URI and the PRM `resource`. No trailing slash (the script refuses one) |
| `SHELL_ORIGIN` | `https://artifacts.corp.com` | viewer shell origin; redirect is `${SHELL_ORIGIN}/auth/callback` |
| `MCP_APP_NAME`, `CONNECTOR_APP_NAME`, `SHELL_APP_NAME` | `artifacts-mcp`, `claude-connector`, `artifacts-viewer-shell` | display names, used as the idempotency key |
| `SCOPE_NAME` | `artifacts.publish` | delegated scope exposed by the resource; APIM checks `scp` for it |
| `CLAUDE_REDIRECT` | `https://claude.ai/api/mcp/auth_callback` | Claude's callback, verified in DESIGN §11 |
| `LOOPBACK_REDIRECT` | `http://localhost` | loopback redirect for Claude Code on a developer laptop; Entra matches any port on `http://localhost` |
| `PUBLISHERS_GROUP_ID` | empty | object id of the Entra group whose members may publish; assigned to the resource app |
| `ADMIN_CONSENT` | `0` | `1` runs `az ad app permission admin-consent` (needs Global/Privileged Role Administrator) |

## What each registration is

**`artifacts-mcp` (resource).** Single tenant. Application ID URI exactly `MCP_URL`. One delegated scope
`artifacts.publish` (type `User`, so admin consent is not strictly required, but see below). `api.requestedAccessTokenVersion: 2`
so the token carries `aud = <client id>` and `scp`, which is what `validate-azure-ad-token` in `infra/apim/policies/mcp-server.xml`
checks. The connector is pre-authorised on the scope. Its service principal has **assignment required** on, so
only assigned users or groups receive a token for it, from any client.

**`claude-connector` (client).** Public client (`isFallbackPublicClient: true`), **no secret**, redirect URIs on the
public-client platform: the Claude callback and `http://localhost`. Requests `artifacts-mcp/artifacts.publish`.
Registering the Claude callback under the Web platform instead would make Entra demand a client secret at the token
endpoint (AADSTS7000218); Claude's "Use your own OAuth client" mode sends none.

**`artifacts-viewer-shell` (confidential web app).** Web redirect `${SHELL_ORIGIN}/auth/callback`, delegated
`openid` and `profile` on Microsoft Graph (ids resolved from the tenant at run time), implicit flow off. The shell
(`viewer-shell/`, agent-serve) uses MSAL authorization code flow with the client secret read from Key Vault secret
`entra-shell-client-secret` through the Secrets Store CSI driver.

## Values that must match, and what breaks when they do not

| Must be identical | Where it lives | Failure if not |
|---|---|---|
| `MCP_URL` | Entra Application ID URI; connector dialog URL; PRM `resource` (`infra/apim/policies/prm.xml`); `WWW-Authenticate` `resource_metadata` path; the `mcpServerName` path in `apim.bicep` | **AADSTS9010010** at connector sign-in when the App ID URI differs from the URL Claude requests (trailing slash included); Claude refuses the connector at discovery when PRM `resource` differs from the typed URL |
| `MCP_URL/artifacts.publish` | PRM `scopes_supported`; the scope Claude asks Entra for | consent prompt fails or the token lacks `scp` and APIM returns 401 |
| `artifacts-mcp` client id | APIM named value `artifacts-mcp-client-id` (token audience) | 401 `Unauthorized` from APIM on every tool call |
| `claude-connector` client id | APIM named value `claude-connector-client-id`; connector dialog client ID | 401 from APIM (`client-application-ids` mismatch) |
| tenant id | APIM named value `tenant-id`; PRM `authorization_servers`; shell `AZURE_TENANT_ID` | token issuer mismatch, 401 |

Change the auth settings of a connector and it must be deleted and re-added: Claude locks them after creation.

## Admin consent

`artifacts.publish` is a user-consentable scope and the connector is pre-authorised, so each user *can* consent on first
sign-in. Grant admin consent anyway (`ADMIN_CONSENT=1` or Enterprise apps → `claude-connector` → Permissions → Grant
admin consent) so tenants that disable user consent, which most do, still work, and so `verify.sh` can prove the grant
exists (`consentType: AllPrincipals`).

## Groups

- `artifacts-approvers` — the Entra security group assigned to the Azure DevOps Environment `artifacts-dynamic`
  approval check (DESIGN D10, integration item I8). Create it (`az ad group create --display-name artifacts-approvers
  --mail-nickname artifacts-approvers`), add the approvers, then in Azure DevOps: Pipelines → Environments →
  `artifacts-dynamic` → Approvals and checks → Approvals → add the group, timeout 7 days. This script does not touch
  Azure DevOps.
- Publishers — whichever group should be allowed to publish, passed as `PUBLISHERS_GROUP_ID`; the script assigns it to
  the `artifacts-mcp` service principal. Without it, assignment-required blocks everyone until someone is assigned in
  Enterprise apps → `artifacts-mcp` → Users and groups.

## Prerequisites and gotchas

- The host of `MCP_URL` must be a **verified domain** of the tenant; Graph rejects an Application ID URI on an unverified host.
- `http://localhost` is accepted by Entra as a public-client redirect for loopback flows on any port; `http://127.0.0.1` is a separate entry if a client uses it.
- Re-running `create.sh` is safe: it finds apps by display name, keeps the existing scope id, and PATCHes the same shape every time. Renaming an app creates a new one.
- The shell client secret is never created or printed by the script; the one-liner it prints at the end moves it straight into Key Vault.

## UNVERIFIED (no tenant available)

- Scope string format Entra expects for a URL-style App ID URI (`<URI>/artifacts.publish`), DESIGN §11.
- Whether `isFallbackPublicClient` plus a public-client redirect is what Claude's token exchange needs, versus a SPA-platform redirect (Microsoft's Entra MCP guidance uses public clients; Phase 0 confirms).
- How Claude Code is pointed at a pre-registered client id for a remote HTTP MCP server; the loopback redirect is registered so that the flow has what it needs when it is.
- `az ad app create --public-client-redirect-uris` and `--is-fallback-public-client` flag names (az 2.60+); `az rest` PATCH bodies follow the Graph v1.0 `application` schema.
