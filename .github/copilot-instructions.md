# Instructions for AI assistants in this repository

This repo is the Publish-to-AKS platform: Claude Cowork artifacts published to a private AKS cluster behind a security gate. It was built agent-first; everything you need is in files, not in anyone's head.

## Read before doing anything
1. `README.md` — layout and directory ownership.
2. `STATUS.md` — the single source of truth: milestones, tasks, integration items, decisions, daily log. Update your rows here; append one line to the daily log per working day. Never rewrite history in it.
3. `CLAUDE.md` — the working rules (they apply to any AI assistant, not just Claude): files under 300 lines, Azure behind interfaces with offline fakes, no secrets anywhere ever, done means tests pass.
4. `DESIGN.md` — the architecture and the numbered decisions D1–D13 with their reasoning. Do not contradict a decision without recording a new one in STATUS.md's decisions log.
5. `docs/HANDOFF.md` — if you are in the integration environment: the ordered plan for I1–I8 and milestones M2–M5, with commands and verification per step. `docs/M2-RUNBOOK.md` is the detailed M2 procedure.

## Hard rules
- `contracts/` is frozen. A change there is a PR with a stated reason, never a silent edit. Scanner rule ids, states, and API shapes all come from it; `scanner/src/test/policy.test.ts` fails on drift by design.
- No secrets in code, comments, tests, or examples. Config via env vars; real values live in Key Vault. `tests/handoff-check.sh` greps for credential-shaped strings and must stay green.
- Nothing calls the Kubernetes API at run time (D12). Deployments go through the Azure DevOps pipelines and Helm charts (`charts/`), never ad-hoc kubectl against prod namespaces.
- No shared keys between APIM and services (user decision): services verify the forwarded Entra token themselves; identity comes from token claims.
- Every runtime change must keep these green before commit: the per-package `npm test` suites, `./deploy/validate.sh`, and `tests/negative.sh` against `tests/dev-stack.sh start` (the full system runs locally with memory backends, no Azure needed).

## Working style
- One directory, one concern. Check `STATUS.md` task ownership before touching a directory.
- Add a corpus bundle under `tests/corpus/<name>/` with an `expected.json` for every new scanner behaviour; the negative suite is the regression harness.
- When an Azure doc and this repo disagree, verify against learn.microsoft.com and record the finding; several resource shapes are marked UNVERIFIED in the READMEs on purpose.
