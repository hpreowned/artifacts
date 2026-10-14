# Publish-to-AKS

Self-hosted publishing of Claude Cowork / Claude Code artifacts to a private AKS cluster, with a security gate.

Start here, in this order:
1. `DESIGN.md` — what we are building and why. Changes by pull request.
2. `STATUS.md` — scope, milestones, who is doing what, what is done. The single source of truth for progress.
3. `CLAUDE.md` — rules every coding agent follows in this repo.
4. `contracts/` — frozen interfaces: manifest schema, intake OpenAPI, states, findings and rule IDs.
5. `tests/corpus/` — the adversarial and benign bundles every change is tested against.

Directories (one owner each): `intake-api/`, `scanner/`, `static-gateway/`, `viewer-shell/`, `skill/`, `cli/`, `infra/`, `deploy/`, `pipelines/`, `tests/`.
