# Launchpad platform contract — one page, borrowable

This card describes what the internal artifact host accepts. It is written to be copied or linked by any
build skill in the organization: if a team knows an artifact will be published internally, conforming
during the build is cheaper than retrofitting at publish time. The publishing skill (`publish-to-aks`)
aligns and verifies against this same card; the platform's scanner enforces it regardless.

Common to every tier: the bundle is one directory (any name; `dist/` by convention) and everything the artifact needs ships inside it, data as files, no secrets or
internal hostnames anywhere (including comments and sample data), at most 500 files and 25 MiB, no
symlinks, `ttlDays` 1–90 (default 14) and the artifact disappears at TTL. Viewers sign in with corporate
accounts; nothing is public.

## Static (`tier: static`, entrypoint `index.html`)
- Plain files, no server. File types: `html css js json svg png jpg jpeg webp woff2 txt md csv`.
- **Built output is welcome**: a React/Vue/anything app compiled on the author's side (for example
  `vite build`) is a static artifact — local script bundles are served from the artifact's own origin.
  What matters is what remains at run time: no server, no runtime data. Bake all data into the bundle
  at build time. Two build-time gotchas: an app that worked locally against a dev-server proxy loses
  that server when exported static (its fetches will silently die), and client-side routers should use
  hash routing — a deep link to a history-API route 404s.
- *External* scripts only from `https://cdnjs.cloudflare.com/ajax/libs/` or `https://cdn.jsdelivr.net/npm/`,
  exact versions, each listed in the manifest's `externalScripts`. Dependencies compiled into a local
  bundle ship uninspected and run under the same browser containment as every other line of JS.
- Serving blocks at the browser: no `fetch`/XHR/WebSocket (`connect-src 'none'`), no forms posting
  anywhere, no iframes/embeds, no meta refresh, no password inputs, no popups or downloads.
- Honesty note for compiled bundles: the scanner inspects source-level patterns; a page whose DOM is
  built at run time by minified JS shows the scanner an empty shell. Detection weakens, containment
  does not — which is the platform's design (containment first).

## Python (`tier: python`, runtime `python-1`, entrypoint `app.py`)
- One `app.py`; only the curated runtime's libraries are importable (see `python-1-libraries.md`); no
  `requirements.txt` — dependencies are the platform's, not the artifact's.
- No subprocess, sockets, `ctypes`, `pickle`, `eval`/`exec`; file writes only under `/tmp`; no outbound
  HTTP (all egress is denied at run time). Runs only after a human approval.
- **Consider the static export first**: if viewing the app never makes the server answer (charts over fixed
  data, reports, tables), run it once at publish time and ship the output — Plotly/Altair HTML stays fully
  interactive client-side — on the static tier: live in seconds, no approval. Streamlit-style widget apps
  and anything that queries or writes at view time genuinely need this runtime. Python-in-the-browser
  (WASM) is deliberately not supported today.

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
