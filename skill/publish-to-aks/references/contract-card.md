# Launchpad platform contract — one page, borrowable

This card describes what the internal artifact host accepts. It is written to be copied or linked by any
build skill in the organization: if a team knows an artifact will be published internally, conforming
during the build is cheaper than retrofitting at publish time. The publishing skill (`publish-to-aks`)
aligns and verifies against this same card; the platform's scanner enforces it regardless.

Common to every tier: everything ships in one directory (`dist/`), data as files inside it, no secrets or
internal hostnames anywhere (including comments and sample data), at most 500 files and 25 MiB, no
symlinks, `ttlDays` 1–90 (default 14) and the artifact disappears at TTL. Viewers sign in with corporate
accounts; nothing is public.

## Static (`tier: static`, entrypoint `index.html`)
- Plain files, no build step, no server. File types: `html css js json svg png jpg jpeg webp woff2 txt md csv`.
- Scripts only from `https://cdnjs.cloudflare.com/ajax/libs/` or `https://cdn.jsdelivr.net/npm/`, exact
  versions, each listed in the manifest's `externalScripts`.
- Serving blocks at the browser: no `fetch`/XHR/WebSocket (`connect-src 'none'`), no forms posting
  anywhere, no iframes/embeds, no meta refresh, no password inputs, no popups or downloads. Data that
  would be fetched must ship as a file.

## Python (`tier: python`, runtime `python-1`, entrypoint `app.py`)
- One `app.py`; only the curated runtime's libraries are importable (see `python-1-libraries.md`); no
  `requirements.txt` — dependencies are the platform's, not the artifact's.
- No subprocess, sockets, `ctypes`, `pickle`, `eval`/`exec`; file writes only under `/tmp`; no outbound
  HTTP (all egress is denied at run time). Runs only after a human approval.

## Node prototype (`tier: node`, runtime `node-20`, entrypoint `package.json`)
- A self-contained full-stack prototype: `package.json` with a `start` script serving client and API on
  `$PORT`; `package-lock.json` resolved against the JFrog npm mirror. The pipeline installs dependencies
  with `npm ci --ignore-scripts` — no `node_modules/`, no `.env*`/`.npmrc`, no
  `preinstall`/`postinstall`/`prepare` scripts in the bundle.
- All data as files (for example `data/db.json`); every writable path is ephemeral — nothing written at
  run time survives a restart or the TTL. No outbound calls of any kind (egress including DNS is denied);
  no `child_process`, `vm`, `worker_threads`, or raw sockets in the app's own server files.
- Runs only after a human approval; the viewer shows a persistent "Prototype environment. Data is not
  retained." banner. Not a permanent home: approved keepers graduate to normal service hosting.

Manifest schema: `manifest-schema.json` next to this card. Scanner rule ids: the platform's
`contracts/findings.md`.
