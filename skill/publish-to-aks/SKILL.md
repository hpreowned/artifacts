---
name: publish-to-aks
description: Publish a FINISHED artifact (static HTML/JS page, Python app, or self-contained Node prototype) to the company's internal AKS artifact host. Use only when the user is done building and says so — "publish this", "push it to the launchpad", "host this internally", "give me an internal link", "share this with the team". Do not use while an application is still being designed or built; the organization's own build skills own authoring, and this skill only aligns, verifies and publishes the result. Requires the "Artifacts" connector (tools beginPublish and getPublishStatus). Static artifacts go live in seconds behind corporate sign-in; Python and Node artifacts wait for a human approval.
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

1. **Identify the tier** from what exists: plain page assets → `static`; a single `app.py` → `python`;
   a `package.json` application → `node`. Read the matching section of
   `${CLAUDE_SKILL_DIR}/references/contract-card.md` — it is the complete contract this platform enforces.
2. **Conform what is mechanical, in place, into `dist/`**: assemble the files, write
   `dist/manifest.json` per `${CLAUDE_SKILL_DIR}/references/manifest-schema.json` (`schemaVersion` 2,
   `name` lowercase-dashes, `tier`, `runtime` — `null`/`python-1`/`node-20`, `entrypoint` —
   `index.html`/`app.py`/`package.json`, `externalScripts`, `ttlDays` 1–90 default 14,
   `generatedBy: {"tool": "cowork"}`), pin CDN script URLs to exact versions and list them, drop files
   the contract forbids from the bundle (`node_modules/`, `.env*`, `.npmrc`, stray types).
3. **Do not silently change behavior.** Removing a password form, an outbound fetch, or a subprocess
   call changes what the app does. Flag such findings to the user with the contract rule and why it
   exists; change the code only when the user agrees or the change is behavior-preserving (for example
   moving inline data to a `.json` file).
4. **Run `${CLAUDE_SKILL_DIR}/scripts/preflight.sh dist/`.** One line per finding,
   `RULE file:line message`, exit 1 when something would be rejected. Fix or escalate per rule 3 until
   it exits 0. `(warn)`/`(info)` lines do not block but are worth relaying.
5. **Tell the user what alignment found** before publishing anything that needed more than packaging:
   what was conformed, what was flagged, what a rebuild would need. Python and Node artifacts also wait
   for a human approval after upload — say so up front.

## Publishing

6. Call `beginPublish` with the manifest object. Keep `jobId`, `uploadUrl`, `uploadToken`. The token is
   single use and expires in 10 minutes, so continue immediately.
7. Run `${CLAUDE_SKILL_DIR}/scripts/upload.sh dist/ "<uploadUrl>" "<uploadToken>"`.
   - `UPLOADED <jobId> <sha256>` on exit 0: queued for scanning.
   - `NETWORK_BLOCKED` on exit 2: the sandbox cannot reach the publish host. Stop. Tell the user the
     Cowork network-egress allowlist needs the APIM host (`mcp.corp.com`). Do not retry, do not inline
     the bytes, do not look for another route.
   - Other non-zero: a 401 means the token was used or expired — `beginPublish` again and re-upload;
     a 413 means the bundle is over `maxBytes` — shrink it.
8. Poll `getPublishStatus` every 10 seconds, up to 10 minutes, until `rejected`, `awaiting_approval`,
   `live`, `failed` or `expired`.

## Interpreting each state

- `awaiting_upload`, `scanning`, `deploying` — in progress. Keep polling.
- `rejected` — fix every finding in `findings` (each has `rule`, `file`, `line`, `message`) under the
  rule-3 consent rule, rerun preflight, then start again from step 6 with a new `beginPublish`. At most
  3 attempts; if the third is rejected, stop and show the user the remaining findings.
- `awaiting_approval` — Python and Node only. Report `approval.runUrl` and `approval.group`, tell the
  user they will get the URL once a human approves, and stop. Never try to approve anything yourself.
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

Keep it short: the state, the link or the approval run, the expiry, what alignment changed, and any
findings you could not fix. Say "internal link, requires corporate sign-in" so nobody pastes it to a
customer.
