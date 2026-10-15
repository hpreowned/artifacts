# Findings and rule ids

Every finding is `{ rule, severity, file?, line?, message }` (see intake-openapi.yaml `Finding`). Severity `deny` fails the job. `warn` and `info` are returned but do not fail it. `policy.ts` is the only place that maps rules to severities; scanners emit rule ids, not verdicts.

| Rule | Stage | Severity | Meaning |
|---|---|---|---|
| IN-001 | intake | deny | zip larger than 25 MiB |
| IN-002 | intake | deny | more than 500 files |
| IN-003 | intake | deny | zip-slip: path escapes the bundle root |
| IN-004 | intake | deny | symlink or special file in the bundle |
| IN-005 | intake | deny | file type outside the tier's allowlist. static/python: `html css js json svg png jpg jpeg webp woff2 txt md csv py`. node adds: `jsx ts tsx mjs cjs ico map` plus `package.json`/`package-lock.json` by name. `node_modules/` and `.env*` are never file-type questions: see JS-003/JS-004 |
| IN-006 | intake | deny | manifest missing or fails `manifest.schema.json` |
| IN-007 | intake | deny | tier mismatch by content (`.py` in a static bundle; no `app.py` or any `.html` in a python bundle) |
| IN-008 | intake | deny | entrypoint file missing |
| IN-009 | intake | deny | upload is not a readable zip (bad signature, bad CRC, truncated) |
| SEC-000 | secrets | warn | gitleaks binary unavailable; only the built-in regex pack ran. Must never appear in production, alert on it. |
| SEC-001 | secrets | deny | gitleaks finding (rule id in message); the built-in regex pack also emits this id |
| MAL-001 | malware | deny | Defender for Storage result `Malicious` |
| MAL-002 | malware | deny | Defender result `Error`, `Not scanned`, or timed out; resubmit |
| HTML-001 | html | deny | `<script src>` not in the manifest `externalScripts` or not on an allowlisted CDN |
| HTML-002 | html | deny | `<form action>` to any host |
| HTML-003 | html | deny | `<iframe>` or `<frame>` or `<embed>` or `<object>` |
| HTML-004 | html | deny | `<meta http-equiv="refresh">` or `<link rel="import">` |
| HTML-005 | html | deny | `<input type="password">` |
| HTML-006 | html | deny | `eval(`, `new Function(`, `document.write(` with a non-literal argument |
| HTML-007 | html | deny | base64 or hex blob larger than 64 KiB inside a `<script>` |
| HTML-008 | html | warn | `<a>` to an external host (will not open in the sandbox) |
| HTML-009 | html | info | `fetch(`, `XMLHttpRequest`, `WebSocket(` present (blocked at serve time by CSP; reported so authors learn) |
| PY-001 | python | deny | import outside stdlib ∪ `runtime-manifest.json` |
| PY-002 | python | deny | `subprocess`, `os.system`, `os.exec*`, `os.fork`, `os.spawn*`, `socket`, `ctypes`, `pickle`, `marshal`, `eval(`, `exec(`, `__import__`, `importlib`, `compile(` |
| PY-003 | python | deny | `open(` or `pathlib` write mode with a path outside `/tmp` |
| PY-004 | python | deny | `requirements.txt`, `pyproject.toml`, `setup.py`, or any `.whl`/`.tar.gz` present |
| PY-005 | python | warn | threading or asyncio use (allowed, but noted for the approver) |
| JS-001 | node | deny | in the bundle's own server files: `child_process`, `vm`, `worker_threads`, `cluster`, raw `net`/`dgram`/`tls` socket creation, `process.binding` |
| JS-002 | node | deny | `package-lock.json` missing, or a dependency resolved from a registry other than the JFrog mirror (lockfile `resolved` URLs) |
| JS-003 | node | deny | `node_modules/` present in the bundle (dependencies are installed by the pipeline, never shipped) |
| JS-004 | node | deny | `.env`, `.env.*`, or `.npmrc` present in the bundle |
| JS-005 | node | warn | `eval(`, `new Function(`, dynamic `require(<non-literal>)`, or `fetch`/`http.request` to a non-relative URL in the bundle's own files (egress is denied at run time; reported so authors learn) |
| JS-006 | node | deny | no `start` script in `package.json`, or a `preinstall`/`postinstall`/`prepare` script present (the pipeline installs with scripts disabled; lifecycle scripts signal intent) |
| PY-006 | python | deny | a .py file does not parse; imports cannot be verified |
| LLM-001 | review | warn | reserved for the LLM intent review stage (not yet in scope) |

Stage order: intake → secrets → malware (overlapping, see states.md) → html, python, or js (by tier) → verdict. The node tier follows the python tier's state path (scanning → awaiting_approval → deploying → live) and its pipeline is `artifact-node-deploy`.
