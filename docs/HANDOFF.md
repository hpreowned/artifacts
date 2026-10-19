# HANDOFF — continuing Publish-to-AKS in the environment with Azure access

You are picking this up in an environment that has Azure DevOps, the Azure subscription, the private AKS
cluster, JFrog, Entra, APIM and the Claude org settings. The environment this document was written in has
none of those — it could only write code, scripts, Bicep, Helm charts and tests, and verify everything that
does not need a live tenant or cluster. This document is the bridge. Read it once, top to bottom, before
touching anything.

---

## 1. What this is and where things stand

Publish-to-AKS lets an employee publish a Claude Cowork or Claude Code artifact — a static HTML/JS bundle or
a small Python app — to this organization's own private AKS cluster, behind a security gate (intake →
malware/secret/content scanning → human approval for the Python tier), and have a colleague view it signed
in with their own Entra identity. Nothing on the cluster trusts the artifact's content; containment (sandboxed
iframes, no outbound network from Python pods, Azure Policy, mesh authorization) is the actual wall, not the
scanner. `DESIGN.md` is the full rationale and should be treated as settled design (~90% per its own §11
calibration) unless you find something concretely wrong — then it changes by pull request, same as any other
file.

Of the seven milestones in `STATUS.md`, **M0** (contracts frozen, repo scaffolded) and **M1** (static tier
runs end to end on a laptop, memory backends, no Azure) are **done and proven here**: `tests/negative.sh`
passes 21/21 (now 22/22 after two follow-up bundles) against `tests/dev-stack.sh`'s local composition of
intake-api, the scanner worker, static-gateway and viewer-shell, and the full viewer path — shell sign-in
(dev bypass), token mint, gateway cookie, CSP headers, 403 paths — was walked by hand. Every component's unit
suite is green offline (`npm test` with no network, per `CLAUDE.md`). **M2 through M5** are **pending here**
— they need the real subscription, tenant, cluster and Azure DevOps project that only exist in your
environment — and **M7** (Helm charts replacing the raw manifests under `deploy/`) needs real cluster
verification of `helm template`/`helm lint` output even though the charts themselves are being written
alongside this document, on sibling branches, by other agents in this same session. Expect `charts/
artifacts-platform` and `charts/artifact-python` to exist by the time you clone; if they don't yet, M7 is
simply not done and `deploy/*.yaml` raw manifests are still the deployable artifact — `STATUS.md`'s M7 row
tells you which is current.

**Single source of truth: `STATUS.md`, in git.** Not this document, not a wiki page, not Azure DevOps Boards
(which mirrors milestones only, per the decisions log). Every task row, milestone row, integration-item row
and the decisions log live there and are updated by editing the file and committing. When you land a piece of
I1–I8 or cross a milestone gate, edit that row's `State`/`Evidence` cell and append one line to the **daily
log** at the bottom of `STATUS.md` (append-only — never edit a previous day's line). `CLAUDE.md`'s ownership
rule still applies: edit only the rows that are yours to edit; the orchestrator role (whoever is coordinating
in your environment) owns the milestones, integration items and decisions log, exactly as it did here.

---

## 2. Getting the repo

### Primary: `git clone`

The repo is already pushed to a GitHub remote. From the target environment, if it can reach GitHub:

```
git clone https://github.com/<org>/<repo>.git
cd <repo>
git checkout main        # or whichever branch your orchestrator designates as current
```

Confirm you got everything: `git log --oneline | head -5` should show the latest `STATUS.md` daily-log entry
you expect; `git branch -a` should show the day4-handoff and any day4-helm-* branches if M7 is still landing
in parallel — merge or rebase those into `main` per your orchestrator's call before starting M2 work, so you
are not reading a stale `deploy/` tree.

### Fallback: `git bundle`, for an environment that cannot reach GitHub

```
# in an environment that CAN reach GitHub:
git bundle create publish-to-aks.bundle --all

# transfer publish-to-aks.bundle by whatever side channel is available (internal file share, USB, etc.)

# in the target environment:
git clone publish-to-aks.bundle publish-to-aks
cd publish-to-aks
git remote remove origin                         # the bundle has no live remote
git remote add origin https://github.com/<org>/<repo>.git   # re-point at GitHub once network allows, or leave unset
```

A bundle captures every ref at creation time; if the source repo gets new commits after you create it, create
a fresh bundle rather than trying to merge two bundles.

### What is deliberately absent from the repo, and how to regenerate it

- **`.local/`** — `tests/dev-stack.sh`'s working directory: generated dev keys (`VIEW_TOKEN_KEY`,
  `INTERNAL_SHARED_KEY`, `PIPELINE_TOKEN`), the in-memory serving root, and process logs. Regenerate by
  running `tests/dev-stack.sh start` once; it creates `.local/dev.env` with fresh random keys if the file
  doesn't exist.
- **`node_modules/`** in every TypeScript directory (`intake-api/`, `scanner/`, `static-gateway/`,
  `viewer-shell/`, `cli/`). Regenerate with `npm ci` in each (or let `tests/dev-stack.sh start` do it for the
  three it needs).
- **Build output** (`dist/`, `*.tsbuildinfo`) in the same directories. Regenerate with `npm run build` (or
  `npm test`, which builds first).
- **Every secret.** There are no secrets committed anywhere in this repo (`CLAUDE.md`: "No secrets anywhere
  ... not even as a placeholder"). Every value that looks like a key, token or connection string in a
  committed file is either a literal `<placeholder>` or a test fixture under `tests/corpus/static-secret/`
  deliberately shaped to trip the scanner's own secret-detection rule (SEC-001) — it is not a real credential
  and `tests/handoff-check.sh`'s secret grep allowlists that one path by name. Real secrets (Key Vault
  contents, the viewer-shell's Entra client secret, TLS private keys) are generated or imported during the M2
  runbook (`docs/M2-RUNBOOK.md` steps 8–10) directly into Azure Key Vault; they never pass through this repo
  or this document.

### Commit authorship

All commit authorship in this history has been rewritten to the neutral identity `artifacts-platform
<artifacts-platform@users.noreply.github.com>` on purpose — this was a multi-agent authoring process, not one
person's work, and the neutral identity avoids attributing a machine-generated history to any individual.
Before committing anything new in the target environment, set your own identity locally (never globally,
unless that's genuinely what you want):

```
git config user.name "<your name>"
git config user.email "<your email>"
```

Do this once per clone; it does not change past commits, only new ones you make from here.

### Proving the clone is healthy

Run, in order, from the repo root:

```
npm --prefix intake-api ci      && npm --prefix intake-api test
npm --prefix scanner ci         && npm --prefix scanner test
npm --prefix static-gateway ci  && npm --prefix static-gateway test
npm --prefix viewer-shell ci    && npm --prefix viewer-shell test
npm --prefix cli ci             && npm --prefix cli run build && npm --prefix cli test

tests/dev-stack.sh start        # starts intake-api(8080), static-gateway(8081), viewer-shell(8082), memory backends, DEV_AUTH=1
tests/negative.sh --dry-run     # lists every corpus bundle with its expected state/rules — sanity check before the real run
ARTIFACTS_DEV_OID=dev-user tests/negative.sh    # publishes every tests/corpus/* bundle, asserts expected.json; prints a table, exits 0 only if every bundle matches
tests/dev-stack.sh stop
```

Every `npm test` above must pass with no network access (that's the point of the in-memory/local-disk
backend selection in `CLAUDE.md`'s rules). `tests/negative.sh` against the dev stack should match the count
already recorded in `STATUS.md`'s M1 row and daily log (22/22 as of the last entry there — re-check the
current count in `STATUS.md` before you compare, since more corpus bundles may have been added since this
was written). If any of this fails on a clean clone, stop and diagnose before touching Azure — a broken clone
is cheaper to fix now than three steps into the M2 runbook. `tests/handoff-check.sh` (next to this document)
automates the unit-suite half of this list, plus repo-hygiene checks; see its own section below.

---

## 3. Prerequisites in the target environment

### Tools (minimum versions seen working during authoring; newer is generally fine, older is unverified)

| Tool | Minimum | Why |
|---|---|---|
| Node.js | 20 | every TypeScript service and the CLI; `CLAUDE.md`'s language rule |
| Python | 3.12 | matches the curated runtime image (`python-runtime/Dockerfile`'s `jfrog.corp.com/docker/python:3.12-slim`) and `scanner/Dockerfile`'s pinned interpreter; `scanner/imports.py` itself only needs 3.10+ stdlib, but 3.12 avoids `sys.stdlib_module_names` drift between your machine and the runtime (`scanner/README.md`) |
| `az` CLI | 2.60+, with the `bicep` extension | `infra/entra/create.sh` needs `--is-fallback-public-client` and `--public-client-redirect-uris` (added in 2.60); every Bicep file needs `az bicep build` (authored and checked against Bicep CLI 0.46.1) |
| `helm` | whatever ships `helm lint`/`helm template` with the chart API version `charts/` uses once M7 lands — check `charts/*/Chart.yaml`'s `apiVersion` | M7: `deploy/validate.sh` and `tests/handoff-check.sh` both run `helm lint` on every chart under `charts/` if any exist |
| `kubectl` | matching your cluster's minor version (±1) | every `deploy/` apply step and every `tests/m2/*.sh` script |
| Docker | any recent version, with a working daemon | **none of the four Dockerfiles in this repo (`intake-api`, `scanner`, `static-gateway`, `viewer-shell`) have ever actually been built** — the authoring machine had no Docker daemon. Each README says so explicitly ("Not executed here: no Docker daemon on the authoring machine"). Building them for the first time is one of your first real tasks, not a formality |
| `gitleaks` | **the exact version pinned by your org's Azure DevOps pipeline policy** | the decisions log: "gitleaks approved (already enforced by Azure DevOps pipeline policy); scanner pins the same version and rules file" — `scanner/Dockerfile` takes `GITLEAKS_VERSION`/`GITLEAKS_SHA256` as required build args (example in `scanner/README.md` uses 8.21.2, but that is an example, not the pin — use your policy's real version and compute the real sha256) |

### Access

| What | Why | Where it's used |
|---|---|---|
| JFrog push access to `jfrog.corp.com/artifacts/*` | `pipelines/platform-deploy.yml` builds and pushes all five images (four services + `python-runtime`) there | Phase G of `docs/M2-RUNBOOK.md` |
| Azure DevOps project with a **VNet-connected agent pool** | Microsoft-hosted agents cannot reach the private cluster or the private Blob endpoint (`DESIGN.md` §6.12, §9); every pipeline must pin `<your-vnet-pool>` | I8; `docs/M2-RUNBOOK.md` step 20 |
| Subscription roles `infra/README.md` names | Key Vault Secrets Officer + Certificates Officer (push secrets, import TLS certs); Contributor on the resource group (deploy Bicep); whoever runs `az identity create`/`az identity federated-credential create` needs rights on the identities and the AKS OIDC issuer | `infra/README.md`'s deployment order and role-assignment tables; `docs/M2-RUNBOOK.md` Phases B–D |
| Entra **Application Administrator** (Global/Privileged Role Administrator for admin consent) | `infra/entra/create.sh` creates three app registrations; consenting the MCP scope needs elevated rights | I1; `infra/entra/README.md` |
| **APIM owner** (Contributor on the APIM instance) | import the REST API, create the MCP server resource, PRM operation, MCP-scope policy | I2; not needed for M2, required from M3 |
| **Claude org Owner** | add the custom connector with "Use your own OAuth client"; settings lock after creation, so get the Entra/APIM pieces right before this step | I5; M4, not M2 or M3 |

### Network reachability

- The **private AKS API server** must be reachable from wherever you run `kubectl` and from the Azure DevOps
  VNet agent pool specifically (not from a Microsoft-hosted agent — `DESIGN.md` §9's table says this plainly).
- **Private endpoints** for the storage account and Key Vault, if you set `privateEndpointSubnetId` in
  `infra/bicep/main.bicepparam` (leaving it empty keeps both publicly reachable with Entra-only auth, which
  is fine for a dev subscription and is what the runbook assumes by default).
- `jfrog.corp.com` must be reachable from AKS cluster nodes (pulling the five images) and from wherever you
  build them.
- Internal DNS zones for `corp.com` (specifically `artifacts.corp.com`), the wildcard `*.corp-artifacts.net`,
  and `intake.artifacts.internal` need to resolve inside the VNet to the Gateway's internal load-balancer IP
  (`docs/M2-RUNBOOK.md` step 24) — this is the network team's zone, not something this repo manages.
- From M3 on: a **public** DNS record and App Gateway route for `mcp.corp.com`, reachable from Anthropic's
  published outbound range `160.79.104.0/21` (IPv4 only) and from nowhere else at the WAF layer.

---

## 4. Integration items I1–I8

Each of these is a human/ops action this repo cannot perform for you — code and scripts are ready; someone
with the right role has to run them against the real tenant/subscription. `STATUS.md`'s integration-items
table is the live tracker; this section is the one-time map from item to exact commands. `docs/M2-RUNBOOK.md`
sequences I1, I7 and part of I8 into the M2 path in detail — prefer that runbook's step-by-step phrasing when
you're actually executing; this section is the quick-reference index.

### I1 — Two Entra app registrations, byte-identical URI to the MCP URL

- **Owner:** you / identity admin (Application Administrator)
- **Runbook steps:** `docs/M2-RUNBOOK.md` Phase A, steps 1–3
- **Files:** `infra/entra/create.sh`, `infra/entra/verify.sh`, `infra/entra/README.md` (values that must
  match, `AADSTS9010010` troubleshooting), `DESIGN.md` §6.10
- **Commands:**
  ```
  az rest --method GET --url "https://graph.microsoft.com/v1.0/domains/corp.com" --query "{domain:id, verified:isVerified}" -o table
  MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./infra/entra/create.sh --dry-run
  MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com \
    PUBLISHERS_GROUP_ID=<publishers-group-object-id> ADMIN_CONSENT=1 ./infra/entra/create.sh
  MCP_URL=https://mcp.corp.com/artifacts-mcp/mcp SHELL_ORIGIN=https://artifacts.corp.com ./infra/entra/verify.sh
  ```
- **Verification:** `verify.sh` prints `All checks passed.` and exits 0; its values table carries the tenant
  id and all three app/client ids forward into later steps.
- **Unblocks:** M2 (the `artifacts-viewer-shell` app only — real sign-in); M3 (`artifacts-mcp`,
  `claude-connector` — the connector path).

### I2 — APIM: import API, create MCP server, PRM operation, policy

- **Owner:** you / APIM owner
- **Runbook steps:** `docs/M2-RUNBOOK.md` Phase I, step 25 (explicitly **not** on M2's path)
- **Files:** `contracts/intake-openapi.yaml`, `infra/apim/apim.bicep`, `infra/apim/create-mcp-server.sh`
  (fallback if the Bicep MCP-server resource shape is rejected — see §6's UNVERIFIED table), `infra/apim/
  policies/*.xml`, `infra/README.md`
- **Commands:**
  ```
  az deployment group create -g <apim-rg> -f infra/apim/apim.bicep \
    -p apimName=<apim-name> backendUrl=http://intake.artifacts.internal:8080 \
       tenantId=<tenant-id> artifactsMcpClientId=<artifacts-mcp-app-id> claudeConnectorClientId=<claude-connector-app-id>
  # if the mcpServer resource is rejected:
  SUBSCRIPTION_ID=<sub> RESOURCE_GROUP=<apim-rg> APIM_NAME=<apim-name> ./infra/apim/create-mcp-server.sh --dry-run
  ```
- **Verification:** `az apim api show -g <apim-rg> -n <apim-name> --api-id artifacts`; full discovery-flow
  proof is `DESIGN.md` §8 Phase 0's gate, not this step alone.
- **Unblocks:** M3.

### I3 — App Gateway route + public DNS for `mcp.corp.com`

- **Owner:** network team
- **Runbook steps:** `docs/M2-RUNBOOK.md` Phase H (internal cousin, step 24) and Phase I (step 25, public)
- **Files:** `infra/README.md` deployment-order step 7 (exact listener/path-rule/WAF text to hand them);
  nothing is expressed in Bicep here because the gateway is shared and owned elsewhere
- **Commands:** none scripted — this is a request, not a script: listener `mcp.corp.com` → APIM; path rules
  `/artifacts-mcp/*`, `/.well-known/oauth-protected-resource/*`, `/artifacts/v1/*/upload`,
  `/artifacts/v1/*/finalize`; WAF custom rule allowing those paths only from `160.79.104.0/21`, 403 elsewhere.
- **Verification:** `nslookup mcp.corp.com` resolves publicly to the App Gateway; a request to
  `/artifacts-mcp/mcp` from outside `160.79.104.0/21` gets 403 at the WAF.
- **Unblocks:** M3.

### I4 — Cowork network-egress allowlist entry for `mcp.corp.com`

- **Owner:** Claude org admin
- **Runbook steps:** not covered by `docs/M2-RUNBOOK.md` (explicitly M3-only, outside the cluster-side path)
- **Files:** none in this repo — this is purely a Claude org setting
- **Commands:** none scripted; done in the Claude org admin console's Cowork network-egress settings, mode
  "specific domains," entry `mcp.corp.com`.
- **Verification:** from inside a Cowork task, `skill/publish-to-aks/scripts/upload.sh` against the real
  upload endpoint succeeds instead of printing `NETWORK_BLOCKED`.
- **Unblocks:** M3, M4.

### I5 — Custom connector, "Use your own OAuth client"

- **Owner:** Claude org Owner
- **Runbook steps:** not covered by `docs/M2-RUNBOOK.md` (M4, explicitly out of scope there)
- **Files:** `DESIGN.md` §6.10, §9 ("Changed your mind on auth" — settings lock after creation, delete and
  re-add if wrong)
- **Commands:** none scripted; done in the Claude org admin console's connectors page. Needs I1, I2, I3 done
  first — the MCP URL, PRM `resource`, and Entra Application ID URI must be the identical string, including
  path, no trailing slash.
- **Verification:** sign-in succeeds; in a Cowork task, a tool call to `getPublishStatus` with a fake id
  returns a response (not an auth error); APIM logs show the caller's `oid`.
- **Unblocks:** M3's connector-path gate, M4.

### I6 — Skill published to the skills repo

- **Owner:** you
- **Runbook steps:** not covered by `docs/M2-RUNBOOK.md` (M3-only)
- **Files:** `skill/publish-to-aks/` (SKILL.md, `reference/`, `scripts/preflight.sh`, `scripts/upload.sh`),
  `skill/plugin/` (plugin packaging, `.claude-plugin/plugin.json` + `.mcp.json`), `skill/README.md`
- **Commands:** `skill/plugin/build.sh` produces the zip(s); publish per your skills-repo process (outside
  this repo's scope).
- **Verification:** `skill/tests/preflight.test.sh`, `skill/tests/upload.test.sh`, `skill/tests/plugin.test.sh`
  all pass locally first; after publishing, a Cowork task can load the skill and run `preflight.sh`/
  `upload.sh` for real (this is where "Untested here" in `skill/README.md` — real Cowork sandbox binaries,
  real APIM 403s — finally gets exercised).
- **Unblocks:** M3, M4.

### I7 — Defender for Storage enabled on the artifact storage account

- **Owner:** you / security
- **Runbook steps:** `docs/M2-RUNBOOK.md` Phase B, steps 6–7 — **this is the one item that directly blocks
  M2's gate** (the EICAR test has nothing to alert on without it)
- **Files:** `infra/bicep/main.bicep` (`storage.bicep`'s Defender settings resource), `infra/README.md`
  "Defender for Storage" section
- **Commands:**
  ```
  az provider register -n Microsoft.EventGrid
  az provider show -n Microsoft.EventGrid --query registrationState -o tsv   # poll until Registered
  az security pricing show --name StorageAccounts -o table
  az resource show --ids <storage-account-id>/providers/Microsoft.Security/defenderForStorageSettings/current --query properties.malwareScanning
  ```
- **Verification:** plan `Standard`, on-upload malware scanning enabled, `serving/` prefix excluded.
- **Unblocks:** M2.

### I8 — Azure DevOps: VNet agent pool, Environment `artifacts-dynamic` with approval, Queue-builds permission

**D16 addendum (2026-10-18):** create **two** Environments: `artifacts-dynamic` **with** the approval check (the `human` path) and `artifacts-dynamic-auto` **without any check** (the `auto` path, clean scans). Both deploy to the same namespace; the pipelines pick the Environment from the `approvalMode` run parameter the scanner passes. Set `APPROVAL_MODE=always-human` on the scanner for the first integration days if the org wants to watch every deploy once, then unset it (policy).

- **Owner:** you / DevOps admin
- **Runbook steps:** `docs/M2-RUNBOOK.md` Phase G, step 20 (VNet pool half — blocks M2); Environment approval
  and Queue-builds halves are M5-only, exercised by `DESIGN.md` §8 Phase 2's gate
- **Files:** `pipelines/artifact-python-deploy.yml`, `pipelines/artifact-gc.yml`,
  `pipelines/platform-deploy.yml`, `DESIGN.md` §6.12
- **Commands:** from a throwaway pipeline step running on `<your-vnet-pool>`:
  ```
  kubectl get ns                                          # against the <aks-connection> service connection
  az storage account show --name <storage-account>         # against the storage private endpoint
  ```
  Then, in the Azure DevOps UI: create Environment `artifacts-dynamic` with an approval check (assign the
  right approver group, **set the check timeout to 7 days**, not the 30-day default — `DESIGN.md` §9); grant
  the scanner-worker identity `Queue builds` permission on `artifact-python-deploy.yml` specifically.
- **Verification:** the throwaway step succeeds without a timeout (VNet-pool half); a real Python publish
  reaches `awaiting_approval` with no 401/403 in the worker's logs (Queue-builds half, M5).
- **Unblocks:** M2 (VNet-pool half only); M5 (the rest).

---

## 5. Milestone order with gate scripts

Work the milestones in this order; each gate script's exit code and printed verdict is what you paste into
`STATUS.md`'s milestone row.

### M2 — static tier live in the AKS dev namespace

The full ordered path is `docs/M2-RUNBOOK.md` (30 numbered steps, Phases A through K) — follow it directly,
it already sequences I1 (partially), I7 and I8 (partially) along with every Bicep/kubectl/Helm step needed.
Do not re-derive the order from this document; the runbook is authoritative and more detailed than this
summary.

| Gate | Command | Expected | `STATUS.md` line |
|---|---|---|---|
| Smoke test | `./tests/m2/smoke.sh` | prints `SMOKE: PASS`, exit 0 | — (smoke is not a milestone gate by itself, but run it before the three below) |
| Cluster corpus | `./tests/m2/cluster-negative.sh` | prints a line formatted for `STATUS.md`, e.g. `M2 cluster corpus: 22/22 ok (tests/negative.sh against <url>)` | paste that line into M2's `Evidence` cell |
| EICAR + Defender alert | `./tests/m2/eicar-publish.sh` (reads its own warning banner first — quarantines on a laptop with endpoint AV; run from the cluster test job) | prints `EICAR: PASS`; state `rejected`, rule `MAL-001`; a human confirms the Defender for Cloud alert appears (can lag minutes) | append "EICAR: PASS, Defender alert confirmed <timestamp>" |
| Browser checks | walk `tests/m2/browser-checklist.md` top to bottom with a real browser and a real Entra sign-in | every item checked, console strings match exactly | append "browser checklist: all items pass" |

Set M2's `State` to `done` only once all four are green (per `docs/M2-RUNBOOK.md` step 30 — that step is
explicitly **not** this agent's to execute; it's the orchestrator's).

### M3 — connector path proven

Concrete steps, from `DESIGN.md` §8 Phase 0 and the skill's `upload.sh`:

1. Entra: both app registrations exist (I1, done for M2 already covers the identity admin's half; confirm
   `artifacts-mcp` and `claude-connector` specifically, not just the shell app).
2. APIM: import the stub or real OpenAPI, create the MCP server, PRM operation, MCP-scope policy (I2).
3. App Gateway / public DNS for `mcp.corp.com` (I3).
4. Claude org Owner adds the connector, "Use your own OAuth client" (I5); sign in.
5. In a Cowork task, call `getPublishStatus` with a fake id.
6. Cowork egress: add `mcp.corp.com` (I4); upload the skill (I6); in a Cowork task, run
   `skill/publish-to-aks/scripts/upload.sh` against the real (or sandbox) upload endpoint.

| Gate | Command / observation | Expected | `STATUS.md` line |
|---|---|---|---|
| Tool-call identity | check APIM diagnostic logs / Log Analytics for the tool call | `X-Publisher-Oid` (or the equivalent claim APIM projects) carries your real `oid` | "M3: APIM logs show tool call with oid=<oid>" |
| Sandbox upload | `upload.sh`'s own exit code and the intake response, from inside the Cowork task | a sandbox `PUT` returns `201` | "M3: sandbox PUT → 201" |

Both must be green before anything proceeds (`DESIGN.md` §8: "Nothing else proceeds until both are green").
If the `PUT` is blocked by the sandbox egress proxy, decide between changing the egress mode and the base64
fallback mentioned in the same section — that decision goes in the decisions log, not buried in a task row.

### M4 — first publish from Cowork

1. An employee publishes a real artifact from a Cowork task through the connector and the skill.
2. A colleague opens the resulting link, signs in with their own Entra account, and the artifact renders.

| Gate | Command / observation | Expected | `STATUS.md` line |
|---|---|---|---|
| First publish | watch intake-api's job transition via `artifactctl status <jobId>` or the `/events` log | job reaches `live` | "M4: first Cowork publish, job <id>, live at <url>" |
| Colleague view | a second person opens the shell URL and signs in | artifact renders inside the sandboxed frame; audit log line recorded (`viewer-shell` emits one JSON line per view) | "M4: viewed by <upn> at <timestamp>" |

### M5 — Python tier via Azure DevOps

Concrete steps, from `DESIGN.md` §8 Phase 2 and the negative tests there (seven of them) plus the approval
flow:

1. `python-runtime` image built in your CI, pushed to JFrog; `runtime-manifest.json` generated and the
   skill's library reference regenerated from it (`python-runtime/README.md`, `scanner/README.md`'s import
   allowlist).
2. `untrusted` node pool (`deploy/policy/nodepool-untrusted.sh`, already covered in `docs/M2-RUNBOOK.md` step
   13 if you ran the full path) — confirm it, don't re-run blindly.
3. Azure Policy assignments, NetworkPolicy, mesh root AuthorizationPolicy moved from audit/canary to enforce
   (per `deploy/README.md`'s staged rollout notes — wait a week watching for `policy rejection` first).
4. Azure DevOps: `artifact-python-deploy.yml` and `artifact-gc.yml` pipelines; Environment `artifacts-dynamic`
   with the approval check (I8, the half not needed for M2); Queue-builds permission for the scanner-worker
   identity.

| Negative gate (`DESIGN.md` §8 Phase 2) | Action | Expected |
|---|---|---|
| 1 | `app.py` with `os.system("id")` | `rejected` |
| 2 | `import requests` | `rejected` (not in the curated runtime manifest) |
| 3 | passing Streamlit app, at run time: `socket.create_connection(("1.1.1.1", 443))` then `urllib.request.urlopen("http://169.254.169.254/metadata/instance")` | both time out / fail — **this is the non-negotiable gate from §8**: "the wall, proven twice" |
| 4 | `kubectl apply` a pod in `artifacts-dynamic` with `image: docker.io/library/python`, then with `privileged: true` | both denied (Azure Policy, then PSA) |
| 5 | inside a running artifact pod: `ls /var/run/secrets/kubernetes.io` | absent |
| 6 | a non-mesh test pod (with egress allowed, since real artifact pods have none) curling a mesh service in `artifacts-dynamic` | denied by the root AuthorizationPolicy |
| 7 | decline the approval in Azure DevOps | status shows `rejected` with the run link; a timed-out approval reports `expired` (T52, landed) |

Positive: Cowork publishes a Streamlit app, status shows `awaiting_approval` with the pipeline run link,
approving in Azure DevOps moves it to `live`, and the GC pipeline removes it after a 10-minute TTL in a test
run. `STATUS.md` line on full pass: "M5: Python tier negative tests 1–7 pass; positive publish→approve→live→GC
verified."

---

## 6. Aggregated UNVERIFIED items

Everything below was written against vendor documentation, parsed/linted offline, or checked by hand against
an assembled file tree — never run against a live tenant, subscription or cluster, because none was available
while this repo was authored. This table exists so you don't have to re-read every README to find these; the
"Check with" command is the fastest way to resolve each row once you have real access. The authoritative,
plain-English narrative for most of the cluster-facing ones is already woven into `docs/M2-RUNBOOK.md`'s own
per-step "If it fails" notes — this table is the flat index across every README plus `DESIGN.md` §11, not a
replacement for reading the step itself when you get there.

| # | File it came from | What to check | Command / action that checks it |
|---|---|---|---|
| 1 | `infra/README.md`, `deploy/README.md` | `Microsoft.Security/defenderForStorageSettings@2025-06-01` property names | `az deployment group what-if -g <rg> -f infra/bicep/main.bicep -p infra/bicep/main.bicepparam` |
| 2 | `infra/README.md` | APIM MCP server resource shape (`Microsoft.ApiManagement/service/apis@2025-09-01-preview`, `type: 'mcp'`, `mcpTools[]`) — taken from a Microsoft sample, not the ARM reference | `az deployment group create -f infra/apim/apim.bicep ...`; on failure, `infra/apim/create-mcp-server.sh --dry-run` (its own `API_VERSION=2025-03-01-preview` is also unverified); last resort is the portal's "Expose an API as an MCP server" wizard |
| 3 | `infra/README.md` | whether APIM re-runs operation-scope policies (`rest-entra.xml`) when an MCP tool call is proxied to `beginPublish`/`getPublishStatus` | `DESIGN.md` §8 Phase 0 gate — watch whether tool calls 401 while direct REST works; if so, drop the operation-scope policy on those two operations |
| 4 | `infra/README.md`, `DESIGN.md` §11 | scope string format Entra expects in `scopes_supported` for a URL-style App ID URI (`<App ID URI>/artifacts.publish`) | `DESIGN.md` §8 Phase 0 gate; watch whether Claude's discovery or Entra's consent prompt rejects the scope |
| 5 | `infra/entra/README.md` | whether `isFallbackPublicClient` + a public-client redirect is what Claude's token exchange needs, vs. a SPA-platform redirect | Phase 0 connector sign-in; if it fails, try the SPA-platform redirect alternative |
| 6 | `infra/entra/README.md` | how Claude Code is pointed at a pre-registered client id for a remote HTTP MCP server (the loopback redirect is registered defensively) | exercise the Claude Code (not Cowork) connector path once, if you use it |
| 7 | `infra/entra/README.md` | `az ad app create --public-client-redirect-uris` / `--is-fallback-public-client` flag names (az 2.60+); `az rest` PATCH body schema | `az ad app create --help` on your installed `az` version; re-run `infra/entra/create.sh --dry-run` |
| 8 | `deploy/README.md` | Azure Policy built-in parameter names (`allowedContainerImagesRegex`, `allowedCapabilities`, `requiredDropCapabilities`, `allowedHostPaths.paths`, initiative `namespaces`) | `az policy definition show` on each; `deploy/policy/azure-policy-assign.sh` fails loudly and names the lookup if wrong |
| 9 | `deploy/README.md` | kubelet readiness probes reaching pods under the default-deny NetworkPolicy and the ztunnel ALLOW policy | pods go `Ready` after `kubectl apply`; the mesh-root canary (stage 1) proves it for `static-gateway` first |
| 10 | `deploy/README.md` | Istio Gateway pods running under PSA `baseline`; whether `infrastructure.annotations` reach the internal LB Service | `kubectl get svc -n artifacts-system` returns an internal IP (`docs/M2-RUNBOOK.md` step 17) |
| 11 | `deploy/README.md` | Secrets Store CSI `objectType: secret` on a Key Vault **certificate** splitting into `tls.key`/`tls.crt` | Secrets appear after `docs/M2-RUNBOOK.md` step 16; re-check the PFX's exportable key and `objectType: secret` (not `cert`) if they don't |
| 12 | `deploy/README.md` | `-o ro` and v1-style blobfuse flags on the fuse2 path; MSI auth with `allowSharedKeyAccess: false` | pod goes `Ready`; `kubectl exec ... touch /srv/x` fails (read-only proof) |
| 13 | `deploy/README.md` | Gateway API exact-host precedence over the wildcard route in Istio | only provable once a Python artifact exists with its own exact hostname (M5) |
| 14 | `deploy/README.md` | Azure DevOps stage result strings consumed by the `always()` reporting job | decline one approval in a real pipeline run, read the callback payload |
| 15 | `deploy/README.md` | ztunnel log text `policy rejection` and the Prometheus metric label values used in the audit procedure | read one denied connection during the mesh-root canary stage; confirm against your installed ztunnel version |
| 16 | `deploy/README.md` (blobfuse node-identity attachment) | whether the kubelet identity or a dedicated VMSS-attached identity is the right choice, and that it actually has `Storage Blob Data Reader` on `serving` | `docs/M2-RUNBOOK.md` step 12 — this runbook step is explicitly flagged there as "this agent's best reconstruction, not a verified path"; there is no script for it in this repo at all |
| 17 | `intake-api/README.md`, `scanner/README.md`, `static-gateway/README.md`, `viewer-shell/README.md` | all four Dockerfiles — `docker build` itself has never been run (no Docker daemon during authoring) | `docker build -t <name> <dir>/` for each, once a daemon and the real JFrog base images are reachable |
| 18 | `python-runtime/README.md` | same — `python-runtime`'s Dockerfile, plus no `hadolint` available either | `docker build -t python-runtime:dev python-runtime/` (README notes you can substitute `python:3.12-slim` directly for a laptop sanity build before the real JFrog path is reachable) |
| 19 | `intake-api/README.md`, `scanner/README.md` | `BlobBundleStore`/`BlobJobStore`/`ServiceBusQueue` (the real Azure SDK implementations) have never run against a real storage account or Service Bus namespace — container existence, `ifNoneMatch: "*"`, the `by-artifact/` index, peek-lock redelivery, `DefaultAzureCredential` under workload identity | publish `tests/corpus/static-ok` for real against the cluster (`docs/M2-RUNBOOK.md` step 26/27); a job stuck in `scanning` with no scanner error is this failing silently — check `kubectl -n artifacts-system logs deploy/scanner-worker` |
| 20 | `scanner/README.md` | `AzureDevOpsPipelineTrigger` against a real org: the `Queue builds` permission, the `_links.web.href` response shape | trigger a real Python publish (M5) |
| 21 | `scanner/README.md` | the real `gitleaks` binary and its report format (tested here only with a stand-in script) | run the scanner against `tests/corpus/static-secret` on the cluster; confirm `SEC-001` fires with the real binary, not the stand-in |
| 22 | `viewer-shell/README.md` | real Entra sign-in — authority discovery, code exchange, `oid` claim, consent, exact redirect-URI match (`src/msal.ts`, 14 lines, is the one untested file) | `docs/M2-RUNBOOK.md` step 29's browser checklist |
| 23 | `cli/README.md`, `skill/README.md` | real Entra tokens and APIM's actual 403 shape (both fakes accept any bearer / simulate 403) | M3's gate; compare the real APIM 403 body against what `upload.sh` and `artifactctl` expect |
| 24 | `skill/README.md` | behavior inside the real Cowork sandbox (which binaries exist — fallback chains from `zip`→`python3`, `shasum`→`sha256sum`→`openssl`) | run the published skill in a real Cowork task (I6, M3/M4) |
| 25 | `DESIGN.md` §11 | Azure DevOps Pipelines Runs REST API details, Environment approval checks, `KubernetesManifest@1` — "known, long-standing features; not re-verified against live docs today" | confirm task versions directly in your Azure DevOps project during M5 |
| 26 | `DESIGN.md` §11 | "Everything in §6 runs" — not run anywhere; only JSON/YAML/XML parse offline | the entire M2–M5 path is this verification |

---

## 7. What comes back — one-way environment protocol

The integration environment cannot send code back out (organizational restriction). The clone there is
therefore **deploy-only, never upstream**. Treat the environment this repo came from as upstream and this
clone as a disposable snapshot. Four rules keep that workable:

1. **Code flows forward only, in tagged snapshots.** Each copy carried in corresponds to a git tag
   (`snapshot-1`, `snapshot-2`, ...) on upstream's `main`. `git describe --tags` (or the tag name noted at
   copy time) tells you which snapshot you're running. Never let the clone become the only home of a code
   change: an emergency patch made here is fine to unblock the day, but it must be reported back (rule 3)
   or it dies on the next snapshot.
2. **Environment-specific configuration lives OUTSIDE this clone.** Filled values files
   (`charts/*/values.yaml` copies), `.bicepparam` with real ids, tenant/subscription ids, tokens, variable
   groups — keep them in a separate directory or repo in this environment and pass them by path
   (`helm -f /path/to/real-values.yaml`, `az deployment ... --parameters @/path/to/real.bicepparam`).
   Then replacing the code snapshot is a plain overwrite that clobbers nothing you care about.
3. **Findings travel back as information, not commits.** Whatever channel is allowed (notes, screenshots,
   dictation), report per finding: the snapshot tag, the file and line, the symptom (exact command and
   output), and the fix you applied or suggest. Upstream applies the canonical fix, re-tags, and the next
   snapshot carries it. The same applies to resolved UNVERIFIED rows from §6 and to anything touching
   `contracts/` (which stays frozen here too — patch it locally only if truly blocked, and flag it loudly).
4. **STATUS.md splits roles.** The copy here is your live tracker for I1–I8 and M2–M5: update rows and the
   daily log here as you work, and include the changed rows in your reports so upstream can mirror them.
   Upstream's STATUS.md remains the source of truth for code tasks and decisions.


## 8. Known gaps still open in code

Anything in `STATUS.md` marked `todo` as of this writing (double-check `STATUS.md` directly — this list is a
snapshot, it will drift):

- None at hand-off time: T52, T71 and T72 all landed before this document was finalised. The pipeline
  distinguishes a declined approval (`rejected`) from a timed-out one (`expired`) via the Approvals REST API;
  deployment is Helm throughout (`charts/artifacts-platform` for the platform, `charts/artifact-python` per
  artifact, raw manifests and `render.sh` retired). The Approvals Timeline record shape and the live Helm
  rollout remain UNVERIFIED against a real Azure DevOps run and cluster — see the UNVERIFIED table.

If any of these are `done` by the time you read this, trust `STATUS.md` over this list — this document is a
snapshot from the hand-off day, not a live feed.

## Addendum (after snapshot-1): node runtime

Added on 2026-10-15, travels from snapshot-2 on. The launchpad's three runtimes are static, python, and node — one prototype contract (DESIGN D14/§6.13). Integration deltas on top of I1–I8:
- Register `pipelines/artifact-node-deploy.yml` as a second pipeline on the same VNet pool and Environment `artifacts-dynamic`; grant the scanner worker's identity Queue-builds on it; set `ADO_NODE_PIPELINE_ID` on the worker (next to `ADO_PIPELINE_ID`).
- The build stage needs the JFrog **npm** mirror reachable from the pool (`npm ci --ignore-scripts --registry https://jfrog.corp.com/artifactory/api/npm/npm-remote/`) and docker build/push rights for `jfrog.corp.com/artifacts/node-<artifactId>` images.
- Charts: `charts/artifact-node` (validated offline by `charts/tests/node-conformance.sh`, wired into `deploy/validate.sh`). GC already covers `node-*` releases.
- M8's gate (STATUS.md) runs on the cluster exactly like M5's, with `tests/corpus/node-ok` as the acceptance bundle.

## Addendum: the dev cluster, before any Azure resource exists

`docs/DEV-AKS-DEMO.md` runs the platform on the dev AKS cluster with no new Azure resources: one pod from
`charts/artifacts-dev-allinone` (disk-backed, dev auth, HTTP on wildcard-IP hostnames) attached to the
existing Gateway API ingress, images built on a laptop with `scripts/build-platform-images.sh`, server-tier
pipelines played by hand with `scripts/play-node-pipeline.sh` (same Dockerfile, chart and callbacks; the
pipelines read their inputs from intake's new `/record` and `/bundle` endpoints, so they could too). Nothing
cluster-scoped beyond two namespaces. The Terraform request for the real backends (Phase 2) is what turns
this into M2 proper.

## Addendum: the node runtime's first real run (before the cluster)

`scripts/run-node-bundle.sh <bundle>` is a platform-team tool: it builds the real `node-runtime/Dockerfile`
on a laptop with Docker (base image and registry overridable through build arguments the pipeline never
passes) and runs the bundle under the cluster's constraints, probing it over the container network like the
readiness probe. Run it on the React fixture's node bundle before I8's first cluster deploy — it is the
only pre-cluster exercise of the node contract, and it was written on a machine without Docker: its first
real run is on yours (`--dry-run` shows the commands). Expected on the fixture: READY, "egress: denied".

## Addendum: proving the skill before the connector exists

`mcp-local/` is a local stdio MCP server giving **Claude Code** the production tool pair against the local
intake API. Install the skill (`cp -r skill/publish-to-aks ~/.claude/skills/`), register the server
(`claude mcp add artifacts -- node <repo>/mcp-local/dist/mcp-local/src/main.js`), start the stack
(`scripts/run-all.sh`), and publish from a Claude Code session. This validates skill triggering, staging,
preflight, the tool round-trip and state reporting without Entra, APIM, Cowork or the cluster — do it
before I1–I5, so connector work starts against a skill already known to behave. See `mcp-local/README.md`.

The judgment call worth watching is the dev-proxy trap: `tests/fixtures/react-express-app/README.md` is a
React+Express prototype built for exactly that. Run it before calling the local loop complete.

UNVERIFIED: `scripts/run-node-bundle.sh` has never executed against Docker (none on the authoring machine); syntax-checked and dry-run only. First run on the integration laptop.
