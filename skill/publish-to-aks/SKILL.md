---
name: publish-to-aks
description: Publish an HTML/JS, small Python, or self-contained Node demo artifact to the internal AKS artifact host instead of claude.ai. Use when the user says "publish internally", "host this on our cluster", "deploy to AKS", "demo this app internally", or asks for an internal shareable link. Requires the "Artifacts" connector (tools beginPublish and getPublishStatus). Static artifacts go live in seconds behind corporate sign-in; Python and demo artifacts need a human approval first. Demo artifacts expire in 30 days or fewer and keep no state between pod restarts.
---

# Publish to AKS

You are publishing a finished artifact to the company's private artifact host. Colleagues open the
link, sign in with their corporate account, and see it inside a viewer shell. Nothing is public.

Two tools come from the "Artifacts" connector:
- `beginPublish` — manifest in; `jobId`, `uploadUrl`, `uploadToken`, `uploadExpiresAt`, `maxBytes` out.
- `getPublishStatus` — `jobId` in; `state`, `findings`, `url`, `expiresAt`, `approval`, `summary` out.

The artifact bytes go through `${CLAUDE_SKILL_DIR}/scripts/upload.sh`, never through a tool call.
Never base64 or inline the bundle into a tool argument, no matter how small it is.
If the connector is not available, stop and tell the user to ask a Claude org Owner to add it.

## Output contract

Everything the artifact needs lives in one directory, `dist/`:

- Static: `dist/index.html` plus any assets next to it. No build step, no bundler, no server.
- Scripts only from `https://cdnjs.cloudflare.com/ajax/libs/` or `https://cdn.jsdelivr.net/npm/`,
  exact versions, every `<script src>` listed in the manifest's `externalScripts`.
- No `fetch`, XHR or WebSocket: `connect-src 'none'` blocks them at serve time. Data goes in the file.
- No password inputs, no `<form action>`, no iframes, no `<meta http-equiv="refresh">`, no popups,
  no downloads. Links to other sites do not open inside the sandbox.
- No secrets, tokens, keys or internal hostnames anywhere, including comments and test data.
- Allowed file types: `html css js json svg png jpg jpeg webp woff2 txt md csv py`. At most 500
  files and 25 MiB. No symlinks.
- Python: a single `dist/app.py`, tier `python`, runtime `python-1`. Only the libraries in
  `${CLAUDE_SKILL_DIR}/reference/python-1-libraries.md` are importable; no `requirements.txt`.
  No subprocess, sockets, `ctypes`, `pickle`, `eval`/`exec`, file writes outside `/tmp`, or
  outbound HTTP. A Python artifact runs only after a human approves it; tell the user this up front.
- Demo (D14/§6.13): a self-contained Node 20 full-stack prototype, tier `demo`, runtime `node-20`,
  entrypoint `package.json`, for demos and pattern approval only — not a permanent home. Everything the
  app needs ships inside `dist/`:
  - `dist/package.json` with a `start` script that serves everything — static client and API — on
    `$PORT`, and `dist/package-lock.json` resolved against the JFrog npm mirror (the pipeline installs
    with `npm ci --ignore-scripts`; no `preinstall`/`postinstall`/`prepare` script, and no `node_modules/`,
    `.env*` or `.npmrc` in the bundle — the pipeline installs dependencies, the bundle never carries them
    or any secret-shaped file).
  - All data as files inside the bundle, for example `dist/data/db.json`; the app reads and writes only
    its own filesystem, and every writable path is ephemeral — it is gone the moment the pod restarts or
    the demo expires. Tell the user this up front: nothing the app writes at runtime survives.
  - No outbound network calls of any kind: the platform denies all egress, including DNS, so `fetch`/
    `http.request` to anything other than the app's own relative paths will simply hang and time out.
    No `child_process`, `vm`, `worker_threads`, or raw `net`/`dgram`/`tls` sockets in the app's own
    server files (the pipeline installs dependencies; it does not vet them the way the python-1 runtime's
    import allowlist does — ephemerality, egress denial and the human approval are the real wall here).
  - `ttlDays` 1 to 30 (the schema caps demo lower than static/python's 90), default 14. A demo artifact
    waits for a human approval before it runs, exactly like python; tell the user this up front too.
  - The viewer shows a persistent "Demo environment. Data is not retained. Expires &lt;date&gt;." banner;
    do not promise the user anything these constraints contradict (no login system with a real database,
    no file uploads that need to outlive a request, no calls to the company's other internal services).

## Steps

1. Write `dist/manifest.json` following `${CLAUDE_SKILL_DIR}/reference/manifest-schema.json`:
   `schemaVersion` 2, `name` (lowercase, digits, dashes), `tier`, `runtime` (`null` for static,
   `"python-1"` for python, `"node-20"` for demo), `entrypoint` (`index.html`, `app.py`, or
   `package.json` for demo), `externalScripts`, `ttlDays` (1 to 90 for static/python, 1 to 30 for
   demo, default 14), `generatedBy: { "tool": "cowork" }`.
2. Run `${CLAUDE_SKILL_DIR}/scripts/preflight.sh dist/`. It prints one line per finding as
   `RULE file:line message` and exits 1 when something would be rejected. Fix every finding and
   rerun until it exits 0. Lines marked `(warn)` or `(info)` do not block but are worth fixing.
3. Call `beginPublish` with the manifest object. Keep `jobId`, `uploadUrl` and `uploadToken`.
   The token is single use and expires in 10 minutes, so continue immediately.
4. Run `${CLAUDE_SKILL_DIR}/scripts/upload.sh dist/ "<uploadUrl>" "<uploadToken>"`.
   - `UPLOADED <jobId> <sha256>` on exit 0: the bundle is queued for scanning.
   - `NETWORK_BLOCKED` on exit 2: the sandbox cannot reach the publish host. Stop. Tell the user
     the Cowork network-egress allowlist needs the APIM host (`mcp.corp.com`). Do not retry, do
     not inline the bytes, do not look for another route.
   - Any other non-zero exit: read the error. A 401 means the token was used or expired; call
     `beginPublish` again and re-upload. A 413 means the bundle is over `maxBytes`; shrink it.
5. Poll `getPublishStatus` with the `jobId` every 10 seconds, for up to 10 minutes, until the state
   is `rejected`, `awaiting_approval`, `live`, `failed` or `expired`. Then act on the state below.

## Interpreting each state

- `awaiting_upload`, `scanning`, `deploying` — in progress. Keep polling.
- `rejected` — the scanner found at least one deny-level problem. Fix every finding in
  `findings` (each has `rule`, `file`, `line`, `message`), rerun preflight, then start again from
  step 3 with a new `beginPublish`. At most 3 attempts in total. If the third attempt is also
  rejected, stop, show the user the remaining findings and ask how they want to proceed.
- `awaiting_approval` — Python and demo only. The artifact passed scanning and is waiting for a human
  in the approver group. Report `approval.runUrl` (the approval run link) and `approval.group`
  (the Entra group that approves), tell the user they will get the URL once approved, and stop.
  Do not poll further and do not try to approve anything yourself.
- `live` — report `url` (the internal link, behind corporate sign-in) and `expiresAt` (when the
  artifact disappears; `ttlDays` controls it). Done.
- `failed` — a platform problem, not the artifact. Report `summary` or the finding message and
  stop. Do not resubmit unless the message asks for a resubmit (for example a malware scan that
  timed out, rule MAL-002).
- `expired` — the upload or the approval timed out. Start again from step 3 if the user still
  wants the artifact published.

## Findings

Rule ids follow the scanner's table. The ones you will see most:

| Rule | Fix |
|---|---|
| HTML-001 | Script host not on an allowlisted CDN, or missing from `externalScripts` |
| HTML-002 / HTML-003 / HTML-004 | Remove the `<form action>`, iframe/embed/object, meta refresh or `<link rel=import>` |
| HTML-005 | Remove the password input; artifacts never collect credentials |
| HTML-006 | Remove `eval(`, `new Function(`, dynamic `document.write(` |
| HTML-007 | A base64/hex blob over 64 KiB in a script; move data to a `.json` or `.csv` file |
| SEC-001 | A secret-looking string; remove it, including from comments and sample data |
| IN-005 / IN-006 / IN-007 / IN-008 | File type outside the allowlist; manifest invalid; tier does not match the files; entrypoint missing |
| PY-001 / PY-002 / PY-003 / PY-004 | Import outside the runtime list; forbidden call; write outside `/tmp`; dependency file present |
| JS-001 | Remove `child_process`, `vm`, `worker_threads`, `cluster`, or raw socket creation from the app's own server files |
| JS-002 / JS-003 / JS-004 | Add or fix `package-lock.json`; remove `node_modules/`; remove `.env*`/`.npmrc` |
| JS-006 | Add a `start` script to `package.json`; remove any `preinstall`/`postinstall`/`prepare` script |
| MAL-001 | The malware scanner flagged the bundle; do not resubmit, tell the user |

## Reporting to the user

Keep it short: the state, the link or the approval run, the expiry, and any findings you could not
fix. Say "internal link, requires corporate sign-in" so nobody pastes it to a customer.
