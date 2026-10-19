---
name: publish-to-aks
description: Publish a FINISHED artifact (static HTML/JS page, Python app, or self-contained Node prototype) to the company's internal AKS artifact host. Use only when the user is done building and says so — "publish this", "push it to the launchpad", "host this internally", "give me an internal link", "share this with the team". Do not use while an application is still being designed or built; the organization's own build skills own authoring, and this skill only aligns, verifies and publishes the result. Requires the "Artifacts" connector (tools beginPublish and getPublishStatus). Static artifacts go live in seconds behind corporate sign-in; Python and Node artifacts deploy automatically when the scan is clean and go to a human approver only when it raises a warning.
---

# Publish to AKS

You are the last mile, not a co-author. The artifact already exists, built however the user and their
build skills chose to build it. Your job: align it with the platform contract, fix what is mechanical,
report what is not, publish it, and shepherd the job to a link. Colleagues open that link, sign in with
their corporate account, and see the artifact inside a viewer shell. Nothing is public.

Two tools come from the "Artifacts" connector:
- `beginPublish` — manifest in; `jobId`, `uploadUrl`, `uploadToken`, `uploadExpiresAt`, `maxBytes` out.
- `getPublishStatus` — `jobId` in; `state`, `findings`, `url`, `expiresAt`, `approval`, `summary` out.

The artifact bytes go through `${CLAUDE_SKILL_DIR}/scripts/upload.sh`, never through a tool call.
Never base64 or inline the bundle into a tool argument, no matter how small it is.
If the connector is not available, stop and tell the user to ask a Claude org Owner to add it.

## Alignment workflow

The user's source tree is read-only to you. All alignment happens in a fresh **staging directory** —
`dist/` by convention, any name works, every script below takes it as an argument. Copy what the bundle
needs into it and conform the copy; never delete or rewrite files in the user's project to make it
comply (removing their `.env` or `node_modules` would break their local setup, and the bundle simply
does not include those files).

1. **Identify the tier** from what exists: nothing executes server-side → `static`; a single `app.py`
   server → `python`; a `package.json` application with its own server → `node`. When two tiers are
   genuinely viable — a thin server whose data could ship as files makes a fine static artifact — put
   the choice to the user: static goes live in seconds with no approval; python/node wait for a human
   approval and run with more machinery. **Prefer the static export when it is honest**: build the app
   yourself (`npm run build`) into the staging directory and bake the data in as files — do not assume
   a build already exists, dev-serving produces none. Before offering static, check for the dev-proxy
   trap: if the app fetches `/api/...` (or anything) at run time, what the user viewed locally included
   a live server, and the static export will look the same and silently not work — surface that and
   either bake the data or publish as `node`. Client-side routing must be hash-based on the static
   tier. The same preference applies to Python, where "build" means run-once-and-capture: if viewing
   never makes the server answer, execute the app at publish time and ship its output (Plotly/Altair
   export to client-side-interactive HTML; tables and images render to files) as a static artifact.
   Streamlit widget apps and anything that queries or writes at view time stay on the python tier;
   Python-in-the-browser (WASM) is not supported. Then read the matching section of
   `${CLAUDE_SKILL_DIR}/references/contract-card.md` — the complete contract this platform enforces.
2. **Stage and conform what is mechanical**: copy the bundle files into the staging directory (an app's
   own built `dist/` subfolder is fine *inside* the bundle — the platform cares about the bundle root,
   not the name), leave out what the contract forbids (`node_modules/`, `.env*`, `.npmrc`, stray file
   types), pin CDN script URLs to exact versions, and write `<staging>/manifest.json` per
   `${CLAUDE_SKILL_DIR}/references/manifest-schema.json`: `schemaVersion` 2, `name` lowercase-dashes,
   `tier`, `runtime` (`null`/`python-1`/`node-20`), `entrypoint` (`index.html`/`app.py`/`package.json`),
   `externalScripts`, `ttlDays` 1–90 default 14, and `generatedBy.tool` set honestly to where you are
   running (`"cowork"` or `"claude-code"`).
3. **Do not silently change behavior.** Removing a password form, an outbound fetch, or a subprocess
   call changes what the app does. Flag such findings to the user with the contract rule and why it
   exists; change the staged copy only when the user agrees or the change is behavior-preserving (for
   example moving inline data to a `.json` file).
4. **Run `${CLAUDE_SKILL_DIR}/scripts/preflight.sh <staging>`.** One line per finding,
   `RULE file:line message`, exit 1 when something would be rejected. Fix or escalate per rule 3 until
   it exits 0. `(warn)`/`(info)` lines do not block but are worth relaying.
5. **Tell the user what alignment found** before publishing anything that needed more than packaging:
   what was conformed, what was flagged, what a rebuild would need. Python and Node artifacts deploy
   automatically when the scan is clean; a warning finding sends them to a human approver first — say
   which to expect once preflight has run (a `(warn)` line means a reviewer will look).

## Publishing

6. Call `beginPublish` with the manifest object. Keep `jobId`, `uploadUrl`, `uploadToken`. The token is
   single use and expires in 10 minutes, so continue immediately.
7. Run `${CLAUDE_SKILL_DIR}/scripts/upload.sh <staging> "<uploadUrl>" "<uploadToken>"`.
   - `UPLOADED <jobId> <sha256>` on exit 0: queued for scanning.
   - `NETWORK_BLOCKED` on exit 2: the sandbox cannot reach the publish host. Stop. Tell the user the
     Cowork network-egress allowlist needs the APIM host (`mcp.corp.com`). Do not retry, do not inline
     the bytes, do not look for another route.
   - Other non-zero: a 401 means the token was used or expired — `beginPublish` again and re-upload;
     a 413 means the bundle is over `maxBytes` — shrink it; a 409 naming `duplicateOf` means this exact
     bundle is already in flight under that job — do not publish again, poll that job with
     `getPublishStatus` and report it.
8. Poll `getPublishStatus` every 10 seconds, up to 10 minutes, until `rejected`, `awaiting_approval`,
   `live`, `failed` or `expired`.

## Interpreting each state

- `awaiting_upload`, `scanning`, `deploying` — in progress. Keep polling. For Python and Node, `deploying`
  with `approval.mode: auto` means the scan was clean and no human is involved; the link follows shortly.
- `rejected` — fix every finding in `findings` (each has `rule`, `file`, `line`, `message`) under the
  rule-3 consent rule, rerun preflight, then start again from step 6 with a new `beginPublish`. At most
  3 attempts; if the third is rejected, stop and show the user the remaining findings.
- `awaiting_approval` — Python and Node only, and only when the scan raised a warning a human has not
  seen before for this app (a version a human already approved, with the same warnings, goes through
  automatically and `approval.reasons` says so): `approval.reasons`
  says why a reviewer is looking. Tell the user in plain words what was flagged and that the platform team
  will review it (usually within a day), that they need do nothing, and that the link follows on approval.
  Then stop. Never try to approve anything yourself. Offer the job id and run link only if they ask.
- `live` — report `url` (internal, behind corporate sign-in) and `expiresAt`. Done.
- `failed` — a platform problem, not the artifact. Report `summary` and stop; resubmit only if the
  message asks for it (for example a timed-out malware scan, rule MAL-002).
- `expired` — the upload or approval timed out. Start again from step 6 if the user still wants it.

## Findings quick reference

| Rule | Fix |
|---|---|
| HTML-001 | Script host not on an allowlisted CDN, or missing from `externalScripts` |
| HTML-002 / 003 / 004 | Remove the external form, iframe/embed/object, or meta refresh |
| HTML-005 | Remove the password input; artifacts never collect credentials |
| HTML-006 / 007 | Remove `eval`/`new Function`/dynamic `document.write`; move big inline blobs to a data file |
| SEC-001 | A secret-looking string; remove it, including from comments and sample data |
| IN-005…IN-008 | File type outside the allowlist; manifest invalid; tier/content mismatch; entrypoint missing |
| PY-001…PY-004 | Import outside the runtime list; forbidden call; write outside `/tmp`; dependency file present |
| JS-001 | Remove `child_process`/`vm`/`worker_threads`/raw sockets from the app's own server files |
| JS-002 / 003 / 004 | Add or fix `package-lock.json` (JFrog-resolved); remove `node_modules/`; remove `.env*`/`.npmrc` |
| JS-006 | Add a `start` script; remove any `preinstall`/`postinstall`/`prepare` script |
| MAL-001 | The malware scanner flagged the bundle; do not resubmit, tell the user |

## Reporting to the user

Write for a business user, not an engineer: what happened, whether they must do anything, when they get
the link. The link, the expiry, what alignment changed, anything you could not fix — in sentences, not
rule ids (translate `JS-005` into "the app tries to call an outside service"). Job ids and run links on
request only. Say "internal link, requires corporate sign-in" so nobody pastes it to a customer.
