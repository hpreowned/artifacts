# viewer-shell

The page a colleague opens: `https://artifacts.corp.com/view/<artifactId>`. Owner: `agent-serve`. Design: `DESIGN.md` §2a, §6.4 (shell CSP), §6.8 (auth is MSAL in the app, not the mesh), §9 (banner).

What `GET /view/<artifactId>` does, in order:

1. Requires a signed-in viewer. Production: Entra ID auth-code flow with `@azure/msal-node` (confidential client, redirect `<SHELL_ORIGIN>/auth/callback`, scopes `openid profile`). The viewer's `oid` is kept in a signed, HttpOnly session cookie (`__Host-shell`, `Secure; SameSite=Lax; Path=/`, 8 h). No MSAL token cache is persisted; nothing is written to disk.
2. Calls intake-api `POST <INTAKE_INTERNAL_URL>/v1/view-token` with header `X-Internal-Caller: <INTERNAL_SHARED_KEY>` and body `{ artifactId, viewerOid }`. A `404` from intake renders the "not live" page.
3. Writes one audit line to stdout: `{"ts","viewerOid","artifactId","userAgent"}`. No other PII. (Startup and error lines go to stderr, so stdout is the audit stream.)
4. Renders a page whose only content is the banner "AI-generated artifact. Never enter passwords or credentials here." (plus "Expires <date>" when intake sends `artifactExpiresAt`, see below) above a full-height iframe:
   `<iframe src="<ARTIFACT_SCHEME>://<artifactId>.<ARTIFACT_DOMAIN>/?t=<token>" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" referrerpolicy="no-referrer">` — no `allow-popups`, no `allow-top-navigation`, no `allow-downloads`.

Response headers on every response:

```
Content-Security-Policy: default-src 'self'; frame-src <ARTIFACT_SCHEME>://*.<ARTIFACT_DOMAIN>; script-src 'self'; style-src 'self' 'sha256-<hash of the inline stylesheet>'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, no-store
```

This is DESIGN §6.4's shell CSP (`default-src 'self'; frame-src ...; script-src 'self'; style-src 'self'`) plus three tightenings (`base-uri`, `form-action`, `frame-ancestors`). The page's single `<style>` block is allowed by its SHA-256 hash, computed once at start from the constant in `src/page.ts`, so there is no `'unsafe-inline'`. `Cache-Control` is in addition to the spec: the page embeds a 5-minute token and must not be cached. The page contains no scripts at all.

Other routes: `GET /auth/callback` (Entra redirect target), `GET /healthz` → `200 ok` for probes. Everything else is `404`; non-GET is `405`.

## DEV_AUTH=1 — read this

With `DEV_AUTH=1` **there is no sign-in**. MSAL is never constructed, `ENTRA_*` and `SHELL_SESSION_KEY` are not read, and every request is treated as viewer oid `dev-viewer`. The process prints a warning to stderr at start. It exists so the local dev stack runs without a tenant. Never set it in a cluster; the deploy manifests must not carry it.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `SHELL_ORIGIN` | yes | This app's origin: production `https://artifacts.corp.com`, local `http://localhost:8082`. Builds the Entra redirect URI `<SHELL_ORIGIN>/auth/callback`, which must be registered on the Entra app byte-for-byte. |
| `ARTIFACT_DOMAIN` | yes | Registrable domain of artifact origins: production `corp-artifacts.net`, local `localhost:8081` (with port). Used in the iframe `src` and the CSP `frame-src`. Must equal the gateway's `ARTIFACT_DOMAIN`. |
| `ARTIFACT_SCHEME` | no | `https` (default) or `http` for the local dev stack. |
| `INTAKE_INTERNAL_URL` | yes | Base URL of intake-api's internal routes: cluster `http://intake.artifacts-system.svc:8080`, local `http://localhost:8080`. |
| `INTERNAL_SHARED_KEY` | yes | Sent as `X-Internal-Caller` on `/v1/view-token`. Same value configured on intake-api. From Key Vault in the cluster. |
| `DEV_AUTH` | no | `1` disables Entra. See above. |
| `ENTRA_TENANT_ID` | when `DEV_AUTH` unset | Tenant of the viewer app registration. |
| `ENTRA_CLIENT_ID` | when `DEV_AUTH` unset | Client id of the viewer app registration (a confidential web app with redirect URI `<SHELL_ORIGIN>/auth/callback`). |
| `ENTRA_CLIENT_SECRET` | when `DEV_AUTH` unset | Its client secret. Env only; from Key Vault in the cluster. Never logged. |
| `SHELL_SESSION_KEY` | when `DEV_AUTH` unset | Base64 of a random key (32 bytes) signing the shell session cookie and the OAuth `state`. Not shared with anything else. |
| `DEV_INSECURE_COOKIES` | no | `1` → session cookie named `shell` without `Secure`, for an `http` origin that is not localhost. Only relevant with real Entra sign-in over plain http. |
| `PORT` | no | Listen port, default `8082`. |

The shell never sees `VIEW_TOKEN_KEY`: intake mints view tokens, the gateway verifies them, the shell only passes the string through.

## Run locally

```sh
npm ci
npm test            # builds, then node:test; no network
export INTERNAL_SHARED_KEY="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"   # same value for intake-api
SHELL_ORIGIN=http://localhost:8082 ARTIFACT_DOMAIN=localhost:8081 ARTIFACT_SCHEME=http \
INTAKE_INTERNAL_URL=http://localhost:8080 DEV_AUTH=1 npm run dev
```

Full local stack: intake-api + worker on `8080` (memory backends, serving directory), static-gateway on `8081` (`SERVE_ROOT` = that serving directory, `ARTIFACT_DOMAIN=localhost:8081`, `SHELL_ORIGIN=http://localhost:8082`, the same `VIEW_TOKEN_KEY` as intake), this shell on `8082` as above. Publish `tests/corpus/static-ok` with `artifactctl publish --wait`, then open the `url` from the status response (`http://localhost:8082/view/<id>`) in a browser. The browser resolves `<id>.localhost` to loopback without any hosts-file change. Leave `DEV_INSECURE_COOKIES` unset on the gateway for browser use (see `static-gateway/README.md` "Cookie").

## Container

```sh
docker build -t viewer-shell:dev .
docker run --rm -p 8082:8082 --read-only -e SHELL_ORIGIN=http://localhost:8082 -e ARTIFACT_DOMAIN=localhost:8081 -e ARTIFACT_SCHEME=http \
  -e INTAKE_INTERNAL_URL=http://host.docker.internal:8080 -e INTERNAL_SHARED_KEY="$INTERNAL_SHARED_KEY" -e DEV_AUTH=1 viewer-shell:dev
```

Multi-stage on `jfrog.corp.com/docker/node:20-slim` (placeholder registry path): build stage runs `npm ci` and `tsc`, then `npm prune --omit=dev`; the runtime stage copies `package.json`, the pruned `node_modules` (`@azure/msal-node` and its dependencies only) and `dist/src`, runs as `USER 65532:65532`, needs no shell (`CMD` is exec form), and writes nothing at run time, so `readOnlyRootFilesystem: true` works with no writable volumes. In the cluster the pod needs egress to `login.microsoftonline.com` (MSAL authority discovery and the code exchange) and to intake-api.

## Expiry in the banner

`/v1/view-token`'s contract (`contracts/intake-openapi.yaml`, T15) returns `{ token, expiresAt, artifactExpiresAt? }`: `expiresAt` is the token's 5-minute expiry, `artifactExpiresAt` (optional, ISO date-time) is the artifact's own TTL expiry, taken from intake-api's job record. The banner renders "Expires <date>" right after the "Never enter passwords or credentials here." sentence, as a plain `YYYY-MM-DD` date, and omits it entirely when intake-api does not send the field.

## Tests

`npm test` covers: the page contains the exact iframe `sandbox` attribute, `src` and `referrerpolicy`, the banner text above the frame, no scripts; the exact CSP and the other headers in local and production configurations; the audit line's exact shape; the 404 path when intake says not live; the dev-auth path; the fake intake receives `(artifactId, viewerOid)`; the real `HttpIntakeClient` against a loopback server asserts method, path, `X-Internal-Caller`, body, and 404/401/malformed handling; the MSAL flow with a fake `AuthCodeClient`: redirect with signed `state` carrying the return path and nonce, callback exchanging the code with that nonce, session cookie attributes in both modes, forged/expired state, Entra `error`, missing `oid`, expired/forged session cookie, open-redirect sanitising of the return path.

## Not tested here, needs Entra

- A real sign-in: authority discovery, the code exchange, the `oid` claim, consent, the exact redirect-URI match. `src/msal.ts` (14 lines) is the only untested file; everything around it is tested with a fake client that mirrors `ConfidentialClientApplication`'s `getAuthCodeUrl` / `acquireTokenByCode` surface (the real class type-checks against the same interface).
- Docker build: no daemon on the authoring machine; the registry path is a placeholder.
- Browser behaviour of the iframe (`sandbox`, `frame-src`, the gateway cookie inside the frame): M2 browser tests.
