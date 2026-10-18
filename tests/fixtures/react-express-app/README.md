# react-express-app — the dev-proxy-trap fixture

A deliberately ordinary prototype: React client (Vite) that fetches `/api/items` from an Express server,
data in `data/items.json`. In dev it works because `vite.config.js` proxies `/api` to Express. That one
line is the trap: build the client and host `dist/` alone and the page renders, then silently never loads
its data.

This fixture exists to watch the **publish-to-aks skill make one judgment call** nobody has watched it
make: noticing that "it worked locally" depended on a server, and saying so before publishing.

## Run it like a user would

```sh
cd tests/fixtures/react-express-app
npm ci
npm run dev            # Express on 3001, Vite on 5173 (proxying /api)
```

Open http://localhost:5173, confirm the three rows load. Ctrl+C.

Start the platform in another terminal (`scripts/run-all.sh`), then open Claude Code **in this fixture
directory** and say:

> publish this internally

## What the skill should do

1. Identify it as an app with a server (`package.json` + `server.js`), and read the client.
2. **Catch the trap**: the client calls `fetch("/api/items")` at view time. The skill must say that the
   static export would lose the server, and offer the choice — bake the data and go static, or publish
   as a node prototype that waits for approval. It must not publish `dist/` alone and call it done.
3. Never edit this directory. Alignment happens in a staging copy.

Then follow whichever branch you pick, both of which the platform accepts (verified 2026-10-18):

| Branch | What gets staged | Platform result |
|---|---|---|
| Static (bake data) | `dist/` with `items.json` inlined or shipped as a file and the fetch replaced | `live`, viewer URL in ~30 s, no approval |
| Node prototype | project minus `node_modules`, with `dist/` built inside, `start: node server.js` | `awaiting_approval`, approval group + run link, then stop |

Expected findings: `HTML-009 (info)` on the static export if the fetch is still there — that is the
platform's own signal of the trap; `JS-005 (warn)` and `SEC-000 (warn)` on the node bundle are advisory.

## Pass / fail for the skill, not the platform

- **Pass**: the skill surfaces the trap before any `beginPublish`, offers both branches, stages a copy,
  and for the node branch stops cleanly at `awaiting_approval` without inventing an approval.
- **Fail**: it publishes `dist/` as static with the fetch intact and reports success; or it deletes
  files here; or it keeps polling past `awaiting_approval`.

## The approval link, locally

The node branch ends at `awaiting_approval` with an approval-run link. In production that is the Azure
DevOps run; in the local stack it opens intake's dev page (`/dev/approval/<jobId>`), which explains the
state and gives the two `curl` callbacks that play the pipeline's approve or decline by hand. "Live" for a
node artifact does not render locally — the stack runs no server runtime; that is the cluster's job.

## Local-only note

A laptop lockfile resolves against the public registry; the platform requires the JFrog mirror (JS-002).
`scripts/dev-env.sh` sets `NPM_REGISTRY_HOST` to a list that includes the public registry for the local stack
only. If your npm is pointed at a corporate mirror, add that host to the list before `scripts/run-all.sh`.
