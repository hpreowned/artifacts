# Rules for every agent in this repo

You are one of several coding agents working in parallel on this repository. Read, in this order, before doing anything: `README.md`, `STATUS.md`, `CLAUDE.md` (this file), the sections of `DESIGN.md` your task references, and everything in `contracts/`.

## Ownership
- Claim exactly the task rows assigned to you in `STATUS.md`. Set `Owner` to your agent name and `State` to `doing` when you start, `done` with `Evidence` when finished. Never edit another agent's rows, the milestones, the integration items, the decisions log, or the daily log. The orchestrator owns those.
- Own only your directories. If you need something from another directory, write what you need as an interface in your own code and note the gap in your final report. Do not reach into another agent's directory.
- `contracts/` is frozen. If a contract is wrong, say so in your report with the exact change you need. Do not edit it.

## Code
- TypeScript, strict, Node 20+. Python only for `scanner/imports.py` (standard library only) and for `tests/` helpers. Bash for skill scripts and pipeline steps. Bicep for Azure resources.
- Files stay under 300 lines. Split before you exceed it.
- Every Azure dependency (Blob, Service Bus, Key Vault, Entra, Azure DevOps, Defender results) sits behind a small interface with two implementations: the real SDK one and an in-memory or local-disk one. The in-memory one is selected by an environment variable so the whole system runs on a laptop with no Azure at all. `npm test` must pass offline.
- Pin dependency versions. Fewest dependencies that do the job. Prefer Node built-ins (`node:test`, `node:http`, `node:crypto`).
- No secrets anywhere: not in code, not in comments, not in tests, not as placeholders. Configuration comes from environment variables; document them in your directory's `README.md`.
- Base images in Dockerfiles come from `jfrog.corp.com/docker/` (placeholder registry; keep the path shape).
- Rule IDs, severities, states, and JSON shapes come from `contracts/`. Do not invent new ones; if you need one, report it.

## Done means
- Your tests pass with `npm test` (or the equivalent your README documents) with no network access.
- Every negative-test expectation in `tests/corpus/*/expected.json` that your component is responsible for is covered by a test you wrote.
- `STATUS.md` rows updated with evidence: the commit hash and the one-line test summary.
- Your directory has a `README.md`: what it does, how to run it locally, every environment variable, what is untested because it needs Azure.
- Commits are atomic, one concern each, messages in the imperative.

## Final report
End with: what you built, how the orchestrator runs it, what you could not test and why, anything in `contracts/` or `DESIGN.md` you believe is wrong, and the interfaces you expect other directories to provide.
