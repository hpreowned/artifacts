# static-gateway

Serves scanned static artifacts, one origin per artifact, from a read-only directory. Owner: `agent-serve`. Design: `DESIGN.md` §2a and §6.4.

`GET /healthz` is handled before any of this and always answers `200 {"ok":true}` (`Content-Type:
application/json`, no security headers, no `Host` parsing) — this is the kubelet readiness/liveness probe
in `deploy/platform/static-gateway.yaml` (`path: /healthz`, `port: http` → container port 8080, matching
this package's `PORT=8080` there), so it must work with any `Host` header or none, including a `Host` that
would otherwise resolve to a real artifact. It never falls through to the file server, even for a live artifact.

A request to `http(s)://<artifactId>.<ARTIFACT_DOMAIN>/<path>` (any other path) is handled in this order:

1. The `Host` must be exactly `<12 lowercase alphanumerics>.<ARTIFACT_DOMAIN>`; anything else is `404`.
2. `Sec-Fetch-Dest: document` (a top-level load) is `302` to `<SHELL_ORIGIN>/view/<artifactId>`. The raw origin only renders inside the shell's iframe.
3. `?t=<view token>` minted by intake-api for this artifact is verified (HMAC-SHA256, constant-time, `exp` checked, `aid` must equal the host's id). On success a session cookie is set and the request is `302`'d to the same path without `t`. A bad token is ignored and falls through to rule 4.
4. Otherwise a valid session cookie for this artifact is required; without one the response is `403` with a short HTML page pointing at the shell link.
5. The file is served from `<SERVE_ROOT>/<artifactId>/<path>` (`index.html` for a trailing `/`). Only allowlisted extensions (`src/static-files.ts`) are served; traversal, encoded traversal, backslashes, null bytes, directories and symlinks that resolve outside the artifact directory are `404`.

Every response, including redirects and errors, carries exactly the DESIGN §6.4 headers:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors <SHELL_ORIGIN>; form-action 'none'; base-uri 'none'; object-src 'none'; sandbox allow-scripts allow-same-origin allow-modals allow-forms
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
Cache-Control: private, no-store
```

Only `GET` and `HEAD` are accepted (`405` otherwise). No framework, no runtime dependencies: `node:http`, `node:crypto`, `node:fs`.

## Tokens

`src/signed-token.ts` is the scheme shared with intake-api and viewer-shell; keep the copies identical.

- Token: `base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, base64url(payloadJson)))`, key = `VIEW_TOKEN_KEY` base64-decoded to raw bytes.
- View token (minted by intake-api, 5 min): `{"t":"view","aid":"<artifactId>","oid":"<viewerOid>","exp":<unix seconds>}`.
- Session cookie value (minted here, 24 h): `{"t":"session","aid":"<artifactId>","exp":<unix seconds>}`.

## Cookie

Production: `__Host-session=<session token>; Secure; HttpOnly; SameSite=None; Path=/; Partitioned`.

This deviates from DESIGN §6.4, which says `SameSite=Strict`, on purpose. The artifact origin is on a different registrable domain from the shell by design (§2a), so every request from inside the shell's iframe is a cross-site request, and browsers do not attach `Strict` or `Lax` cookies to cross-site subresource or nested-navigation requests. With `Strict` the redirect after the token would land on a `403` in every browser. `SameSite=None` makes the cookie travel inside the iframe; `Partitioned` (CHIPS) keys it to the shell as the top-level site, so it also works where third-party cookies are blocked (Safari, locked-down Chrome/Edge policies) and can never be presented from any other embedding. `__Host-` still binds it to this origin and `Path=/`. DESIGN §6.4 should be updated to say this.

`DEV_INSECURE_COOKIES=1`: the cookie is named `session` and is set as `session=<token>; HttpOnly; SameSite=Lax; Path=/`, because `__Host-`, `SameSite=None` and `Partitioned` all require `Secure`, which browsers reject on plain `http` origins other than localhost. Use this only for non-browser checks (curl, `tests/negative.sh`) or an `http` origin that is not `localhost`. For browser-based local development leave it unset: Chromium-based browsers accept `Secure` cookies from `http://*.localhost`, so the production cookie works there (Firefox 93+ should behave the same; not verified).

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `SERVE_ROOT` | yes | Directory holding one sub-directory per artifact id. Locally the intake dev stack's `serving/` directory; in the cluster the read-only Blob CSI mount (`/srv`). |
| `ARTIFACT_DOMAIN` | yes | Registrable domain the artifact origins hang off. Production `corp-artifacts.net`; local `localhost:8081` (include the port, the `Host` header carries it). |
| `SHELL_ORIGIN` | yes | Viewer shell origin, used for the top-level redirect, `frame-ancestors` and the 403 page. Production `https://artifacts.corp.com`; local `http://localhost:8082`. |
| `VIEW_TOKEN_KEY` | yes | Base64 of the raw HMAC key shared with intake-api (at least 16 bytes; use 32). From Key Vault via the Secrets Store CSI driver in the cluster. Never commit it. |
| `DEV_INSECURE_COOKIES` | no | `1` → cookie named `session` without `Secure`. See "Cookie". |
| `PORT` | no | Listen port, default `8081`. |

## Run locally

```sh
npm ci
npm test                      # builds, then node:test; no network needed
export VIEW_TOKEN_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"   # same value for intake-api, gateway
SERVE_ROOT=../intake-api/serving ARTIFACT_DOMAIN=localhost:8081 SHELL_ORIGIN=http://localhost:8082 npm run dev
```

Alongside the intake dev stack: intake-api on `8080` with the same `VIEW_TOKEN_KEY` and its serving directory as `SERVE_ROOT`; this gateway on `8081`; viewer-shell on `8082` with `DEV_AUTH=1`, `INTAKE_INTERNAL_URL=http://localhost:8080`, `ARTIFACT_DOMAIN=localhost:8081`, `ARTIFACT_SCHEME=http`. Then open `http://localhost:8082/view/<artifactId>`; the browser resolves `<artifactId>.localhost` to loopback. Add `DEV_INSECURE_COOKIES=1` only for curl-style checks (see "Cookie").

Manual check without the shell:

```sh
curl -si -H 'Host: <id>.localhost:8081' -H 'Sec-Fetch-Dest: document' http://127.0.0.1:8081/          # 302 to the shell
curl -si -H 'Host: <id>.localhost:8081' "http://127.0.0.1:8081/?t=<view token>"                      # 302 + Set-Cookie
curl -si -H 'Host: <id>.localhost:8081' -H 'Cookie: __Host-session=<value>' http://127.0.0.1:8081/   # 200
```

## Container

```sh
docker build -t static-gateway:dev .
docker run --rm -p 8081:8081 --read-only -v "$PWD/../intake-api/serving:/srv:ro" \
  -e SERVE_ROOT=/srv -e ARTIFACT_DOMAIN=localhost:8081 -e SHELL_ORIGIN=http://localhost:8082 \
  -e VIEW_TOKEN_KEY="$VIEW_TOKEN_KEY" static-gateway:dev
```

Multi-stage on `jfrog.corp.com/docker/node:20-slim` (placeholder registry path). The runtime stage contains only `package.json` and `dist/src`, runs as `USER 65532:65532`, needs no shell (`CMD` is exec form) and writes nothing at run time except stdout/stderr, so it runs with `readOnlyRootFilesystem: true` and no writable volumes.

## Tests

`npm test` covers, with a temporary `SERVE_ROOT`: the token layout and every rejection path; host parsing; each handler rule including a token for the wrong artifact, expired tokens, a session token presented as a view token and vice versa; the exact header set on 200, both 302s, 403, both 404s and 405; cookie attributes in both modes; traversal, encoded traversal, symlink escape, unknown extensions, directories; `HEAD`; `/healthz` returns `200 {"ok":true}` with an arbitrary `Host`, with no `Host`, and with a live artifact's own `Host` (never the file), and every other path's behaviour is unchanged (22 tests total).

## Not tested here

- Docker build: no Docker daemon on the authoring machine and the registry path is a placeholder. The Dockerfile is straightforward; verify `docker build` once the base image path is real.
- Browser cookie behaviour inside the shell iframe (`SameSite=None; Partitioned`) and `Secure` cookies over `http://*.localhost`: needs a browser; covered by the M2 browser tests.
- The Blob CSI mount: the gateway only needs a directory; tested against a temp directory.
