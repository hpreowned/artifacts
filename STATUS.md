# STATUS — single source of truth

Updated: 2026-10-14 by orchestrator (Claude Code, session 1).

How this file works: `DESIGN.md` is the what and why (changes by PR). This file is where we are. Agents edit only the `Owner`, `State`, `Evidence` cells of their own task rows. The orchestrator owns milestones, integration items, the decisions log and the daily log. States: `todo`, `doing`, `blocked`, `done`.

## Scope (frozen 2026-10-14)

| ID | Scope item | Design ref |
|---|---|---|
| S1 | Static tier: artifact from Cowork or Claude Code → scan → served from Blob behind the viewer shell | §5, §6.4, D1, D4, D5, D8 |
| S2 | Python tier: curated runtime, Azure DevOps pipeline, Environment approval, dedicated node pool | §6.5–6.8, §6.12, D6, D10, D12 |
| S3 | Integrations: Entra apps, APIM MCP server, App Gateway and public DNS, Cowork egress, connector, skills repo | §6.9, §6.10 |
| S4 | Pattern hardening: negative corpus as regression suite; LLM review stage is **pending a decision**, not in scope yet | §8 Phase 3 |

Out of scope for the POC: Node runtime tier, scale-to-zero, per-artifact CSP script hashes, per-user quotas, Veracode.

## Milestones

| M | Name | Gate (must pass to cross) | State |
|---|---|---|---|
| M0 | Contracts frozen, repo scaffolded, agents briefed | `contracts/`, `tests/corpus/` committed; four agents launched with their rows | done 2026-10-14 |
| M1 | Static tier runs locally end to end | `tests/negative.sh` passes against the local dev stack (memory backends) | todo |
| M2 | Static tier live in the AKS dev namespace | real internal URL; corpus passes on cluster; EICAR upload rejected with a Defender alert; browser tests for `static-fetch` and `static-navigate` pass | todo |
| M3 | Connector path proven | a tool call through APIM logs the caller oid; a `PUT` from inside a Cowork task returns 201 | todo |
| M4 | First publish from Cowork | an employee publishes from Cowork, a colleague opens the link and signs in | todo |
| M5 | Python tier via Azure DevOps | approval in Azure DevOps; runtime socket and IMDS tests fail as designed; foreign image denied by Azure Policy; GC removes an expired app | todo |

## Tasks

| ID | Task | Owner | State | Done when | Evidence |
|---|---|---|---|---|---|
| T01 | Repo, control files, contracts, corpus | orchestrator | done | this commit | initial commit |
| T02 | Integrate M1: run `tests/negative.sh` on the merged local stack, fix seams | orchestrator | todo | corpus passes locally | |
| T03 | Standup page generated from this file | orchestrator | done | page link in daily log | `gen-status.py` → https://claude.ai/code/artifact/122a8acb-4551-49b9-b8dd-eab812cbbc8f |
| T10 | `intake-api/`: every operation in `contracts/intake-openapi.yaml`; job store behind an interface (memory + Blob); one-time upload tokens; `/events` transitions per `contracts/states.md`; `/view-token` HMAC minting | agent-intake | todo | `npm test` offline; OpenAPI conformance test for each operation | |
| T11 | `scanner/`: queue worker (memory + Service Bus); stages IN, SEC (gitleaks via child process, skip-with-warning when binary absent), MAL (Defender tag reader behind an interface, memory fake), HTML (`checks.ts`), PY (`imports.py` stdlib `ast` + `checks.ts`), `policy.ts` verdict; static publish = copy to a serving store (memory + Blob); python = pipeline trigger behind an interface (fake + Azure DevOps REST) | agent-intake | todo | every `tests/corpus/*/expected.json` rule asserted by a unit test | |
| T12 | Local dev stack: one command runs intake + worker in-process with memory backends and a local `serving/` directory | agent-intake | todo | documented in `intake-api/README.md`; `artifactctl publish` of `static-ok` reaches `live` | |
| T20 | `static-gateway/`: host → artifact id; `Sec-Fetch-Dest: document` → 302 to shell; `?t=` token verify → `__Host-` cookie; every header in DESIGN §6.4; serve from a root directory (local path or Blob CSI mount) | agent-serve | done | header and redirect tests pass offline | `55d02c7` — `static-gateway`: `npm test` 19/19 node:test pass offline: exact §6.4 header set and order on 200/302/403/404/405, host→id, Sec-Fetch-Dest redirect, `?t=` verify→`__Host-session` (and `session` with `DEV_INSECURE_COOKIES=1`), wrong-aid/expired/forged/wrong-type tokens, traversal and symlink escape, HEAD. `connect-src 'none'` (corpus `static-fetch`) asserted; browser behaviour is M2. |
| T21 | `viewer-shell/`: MSAL sign-in (dev bypass behind an env flag), audit log line per view, mint view token via intake `/view-token`, iframe page with the shell CSP and the "never enter credentials" banner | agent-serve | done | page test passes; token round-trip test with a fake intake | `55d02c7` — `viewer-shell`: `npm test` 16/16 node:test pass offline: page with exact iframe `sandbox`/`referrerpolicy`, banner above frame, no scripts; exact shell CSP (`frame-src` pinned to the artifact domain, corpus `static-navigate`; `frame-ancestors 'none'`; `style-src` by hash); one audit JSON line per view; 404 when not live; `DEV_AUTH=1`→`dev-viewer`; fake-intake and loopback `HttpIntakeClient` round trips (`X-Internal-Caller`, body); MSAL auth-code flow with a fake client. Real Entra sign-in untested. |
| T22 | Dockerfiles for gateway and shell on the JFrog Node base; non-root, read-only root compatible | agent-serve | done | `docker build` documented; image runs as uid 65532 | `55d02c7` — both Dockerfiles multi-stage on `jfrog.corp.com/docker/node:20-slim`, `USER 65532:65532`, exec-form `CMD`, nothing written at run time (read-only root OK); build and `--read-only` run documented in each README. Not executed: no Docker on the authoring machine and the registry path is a placeholder. |
| T30 | `skill/publish-to-aks/`: SKILL.md per DESIGN §6.3; `reference/manifest-schema.json` (copy of contract); `reference/python-1-libraries.md` generated from `tests/runtime-manifest.python-1.json`; `scripts/preflight.sh`; `scripts/upload.sh` with `NETWORK_BLOCKED` detection | agent-client | todo | preflight flags every static corpus bundle that the scanner would reject on SEC/HTML rules; upload.sh works against the local stack | |
| T31 | `cli/artifactctl`: `preflight`, `publish [--wait]`, `status`; config via `ARTIFACTS_API_URL`, `ARTIFACTS_TOKEN` | agent-client | todo | `artifactctl publish --wait tests/corpus/static-ok` prints `live` against the local stack | |
| T32 | `tests/negative.sh`: publish every corpus bundle through `artifactctl`, assert `expected.json` (state and rules), exit non-zero on any mismatch | agent-client | todo | script runs against `ARTIFACTS_API_URL`; dry-run mode lists what it would do | |
| T33 | Plugin packaging: `.claude-plugin/plugin.json` + `.mcp.json` alongside the skill, for skills repos that accept plugins | agent-client | todo | zip layout matches DESIGN §6.3a | |
| T40 | `infra/`: Bicep for storage account + containers + Defender for Storage on-upload scanning with a monthly cap; Service Bus namespace + queue; Key Vault; APIM API imported from `contracts/intake-openapi.yaml`, MCP server over the two `x-mcp-tool` operations, PRM operation, MCP-scope policy from DESIGN §6.10; App Gateway route or `ip-filter` alternative | agent-platform | todo | `az bicep build` clean; unverified resource shapes marked in README | |
| T41 | `infra/entra/`: idempotent script creating the two app registrations exactly per DESIGN §6.10, with a verification script that prints the values to paste into the connector dialog | agent-platform | todo | script dry-runs without a tenant; README lists every value and why it must match | |
| T42 | `deploy/`: namespaces with PSA and mesh labels, ResourceQuota, Istio Gateway with both listeners, HTTPRoute templates, NetworkPolicy, mesh root AuthorizationPolicy (audit first), Azure Policy assignment script, `untrusted` node pool script, python artifact Deployment template + `render.sh`, platform Deployments for intake, worker, gateway, shell | agent-platform | todo | every manifest parses; `render.sh` output matches DESIGN §6.6 | |
| T43 | `pipelines/`: `artifact-python-deploy.yml` per DESIGN §6.12, `artifact-gc.yml`, `platform-deploy.yml` | agent-platform | todo | YAML parses; pipelines reference only the service connections named in DESIGN | |
| T44 | `python-runtime/`: Dockerfile per DESIGN §6.5 on the JFrog Python base; script that emits `runtime-manifest.json` from the installed packages | agent-platform | todo | Dockerfile lints; manifest script tested with a fake pip list | |

## Integration items (people, not agents)

| ID | Item | Owner | State | Next action | Target |
|---|---|---|---|---|---|
| I1 | Two Entra app registrations (DESIGN §6.10), URI byte-identical to the MCP URL | you | todo | run `infra/entra/create.sh` or hand the README to the identity admin | week 1 |
| I2 | APIM: import API, create MCP server, PRM operation, policy | you / APIM owner | todo | hand `contracts/intake-openapi.yaml` and `infra/apim/` to the APIM owner | week 1 |
| I3 | App Gateway route + public DNS for `mcp.corp.com` | network team | todo | request with the hostname and the two path prefixes | week 1 |
| I4 | Cowork network-egress allowlist entry for `mcp.corp.com` | Claude org admin | todo | request | week 1 |
| I5 | Custom connector added with "Use your own OAuth client" | Claude org Owner | todo | needs I1, I2, I3 | week 2 |
| I6 | Skill published to the skills repo | you | todo | needs T30 | week 2 |
| I7 | Defender for Storage enabled on the artifact storage account | you / security | todo | needs T40 | week 1 |
| I8 | Azure DevOps: VNet agent pool confirmed, Environment `artifacts-dynamic` with approval check, Queue-builds permission for the worker identity | you / DevOps | todo | needs T43 | week 2 |

## Decisions log (append-only)

- 2026-10-14 D1–D12 as recorded in `DESIGN.md` §4.
- 2026-10-14 ClamAV not approved; malware stage is Defender for Storage on-upload scanning.
- 2026-10-14 gitleaks approved (already enforced by Azure DevOps pipeline policy); scanner pins the same version and rules file.
- 2026-10-14 All AKS deployments through Azure DevOps; nothing calls the Kubernetes API at run time (D12).
- 2026-10-14 One shared namespace for the Python tier, not one per artifact.
- 2026-10-14 LLM review stage: recommended as deny-or-escalate only, with an eval corpus; **decision pending**. `static-injection` is in the corpus for it already.
- 2026-10-14 Progress tracking lives in this file in git; Azure DevOps Boards mirrors milestones only.
- 2026-10-14 Gateway session cookie is `SameSite=None; Partitioned`, not `Strict`: the artifact origin is cross-site to the shell by design. DESIGN §6.4 corrected (agent-serve finding).

## Daily log (append-only, one line per day)

- 2026-10-14 — Day 1. Repo initialised. `DESIGN.md` v2, contracts, 21-bundle corpus, control files committed. Four agents launched: intake, serve, client, platform. Standup page: https://claude.ai/code/artifact/122a8acb-4551-49b9-b8dd-eab812cbbc8f
