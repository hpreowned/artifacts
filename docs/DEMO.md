# Local demo run book

A 12–15 minute live demo of the launchpad on one laptop: no Azure, no cluster, no sign-ins. Everything runs
from this repo with memory backends (`tests/dev-stack.sh`). Works identically in any environment with
Node 20+ and Python 3.10+ on PATH. Commands assume the repo root as the working directory.

## Before the audience arrives (10 minutes)

```sh
node -v && python3 --version          # need v20+ and 3.10+
for d in intake-api scanner static-gateway viewer-shell cli; do npm --prefix $d ci; done
npm --prefix cli run build
tests/dev-stack.sh start              # intake+scanner 8080, gateway 8081, shell 8082
tests/dev-stack.sh status             # three ports answer
```

Dry-run once so the first live publish is warm, then leave the stack running:

```sh
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/static-ok
```

Open a browser tab on the printed URL once to check it renders. Keep a second tab on the repo's
`DIAGRAMS.md` (GitHub renders the Mermaid figures natively — Figure 1 for actors, Figure 4 for going
live, Figure 7 for containment). If anything is stuck: `tests/dev-stack.sh stop`, read `.local/logs/*.log`,
`start` again.

## Act 1 — the story (2 min, no commands)

Show Figure 1 and say: employees generate apps with Claude Cowork; publishing means a scan gate and hosting
on our own cluster behind our own domain, never the vendor's cloud. Three runtimes, one contract: static
pages, Python apps, Node apps — self-contained bundles, data as files inside, ephemeral, TTL, human approval
for anything that executes server-side. Today's demo runs the identical code locally with in-memory Azure
stand-ins; the cluster version differs only in configuration.

## Act 2 — publish, scan, live (3 min)

```sh
cat tests/corpus/static-ok/manifest.json      # the contract an author ships
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/static-ok
```

Open the printed URL. Point at: the persistent banner ("AI-generated artifact. Never enter passwords…"),
the expiry date, and that the page itself is sandboxed in a frame on a *separate domain* — cookie and
phishing isolation by construction. Say: in production the publisher never sees this CLI; Claude Cowork
calls the same two API operations through our API Management, and the viewer signs in with Entra.

## Act 3 — the gate says no (3 min)

```sh
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/static-secret
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/static-password
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/node-child-process
```

Three rejections with file-and-line findings: a leaked credential, a phishing-shaped password field, and
Node server code reaching for `child_process`. Say: findings go back to the AI author in structured form,
so Cowork fixes and resubmits without a human in the loop.

## Act 4 — containment beats detection (3 min, the money shot)

```sh
grep fetch tests/corpus/static-fetch/index.html   # exfiltration attempt, in plain sight
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/static-fetch
```

It goes **live** — deliberately. Open it, open DevTools → Console: the browser itself refused the call
("violates the following Content Security Policy directive: connect-src 'none'"). Say: scanners can be
fooled; the walls cannot. We assume misses and make them harmless — same philosophy server-side, where
prototypes run with zero network egress, no cloud identity, and no storage.

## Act 5 — server runtimes and the approval (2 min)

```sh
ls tests/corpus/node-ok                        # package.json, lockfile, server/, data/db.json inside
ARTIFACTS_DEV_OID=demo-user node cli/dist/artifactctl.js publish --wait --interval 1 tests/corpus/node-ok
```

State ends at `awaiting_approval` with a run link: server-side code never goes live on a machine's say-so —
in production that link is an Azure DevOps approval owned by a human group, and the pipeline builds the
image from our own registry mirror. Same flow for Python (`tests/corpus/python-ok`).

## Finale — the regression proof (1 min)

```sh
ARTIFACTS_DEV_OID=demo-user tests/negative.sh --interval 1
```

29 adversarial and benign bundles, every verdict asserted, green. Say: this table runs on every change,
locally and against the cluster; it is the platform's definition of correct.

## Likely questions

- "When can my team use it?" — integration items I1–I8 in `STATUS.md`; the cluster steps are
  `docs/M2-RUNBOOK.md`; current state on the status page.
- "What about a full React+Express app?" — the node runtime hosts it as a TTL'd prototype if it follows the
  self-containment contract (`DESIGN.md` §6.13); approved keepers graduate to normal service hosting.
- "What if the scanner misses something?" — Act 4 is the answer; also DESIGN §2's threat model and §9's
  failure table.

Afterwards: `tests/dev-stack.sh stop`. To reset demo state entirely: `rm -rf .local`.
