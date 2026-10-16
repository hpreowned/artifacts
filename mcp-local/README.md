# artifacts-mcp-local

A local stdio MCP server that gives **Claude Code** the same two tools APIM publishes in production
(`beginPublish`, `getPublishStatus`), backed by the local intake API. It exists so the `publish-to-aks`
skill can be exercised end to end on a laptop — real skill, real scanner, real viewer — before any Entra,
APIM or cluster work exists. Cowork cannot use it (Cowork only reads remote connectors); Claude Code can.

## Setup

```sh
npm --prefix mcp-local ci && npm --prefix mcp-local run build   # or: scripts/install.sh
scripts/run-all.sh                                              # intake 8080, gateway 8081, shell 8082
claude mcp add artifacts -- node "$(pwd)/mcp-local/dist/mcp-local/src/main.js"
cp -r skill/publish-to-aks ~/.claude/skills/                    # install the skill for Claude Code
```

Then, in Claude Code, build something and say *"publish this internally"*. The skill should stage the
bundle, run preflight, call `beginPublish`, upload via its own `upload.sh`, poll `getPublishStatus`, and
report the viewer URL (static) or the approval run (python/node).

Environment: `ARTIFACTS_API_URL` (default `http://localhost:8080`), `ARTIFACTS_DEV_OID` (default
`local-dev`, becomes the publisher identity), `ARTIFACTS_TOKEN` (any value locally).

## What this proves, and what it does not

Proves: skill triggering on real phrasing, staging instead of mutating the source tree, preflight
behaviour, the tool round-trip, state handling, and the URL/approval reporting — the trigger-eval work,
done practically.

Does not prove: Entra token validation, APIM policies, the Cowork sandbox's egress, Defender scanning,
or anything on the cluster. Those are integration items I1–I8 (`docs/HANDOFF.md`).

## Notes

- MCP speaks newline-delimited JSON-RPC on stdout; every log line here goes to **stderr** on purpose.
- Tool failures come back as `isError` results so the model can read and react to them, rather than
  killing the connection.
- The server is a thin wrapper over `cli/src/client.ts` — the same client `artifactctl` uses, so the CLI
  and the skill exercise identical request shapes.
