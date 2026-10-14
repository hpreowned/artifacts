# skill/plugin/ — packaging for the skills repo

Two layouts, one script. Which one you upload depends on what the company skills repo accepts.

| Repo accepts | Build | Zip layout |
|---|---|---|
| Plugins | `bash skill/plugin/build.sh plugin` → `publish-to-aks.plugin.zip` | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/publish-to-aks/{SKILL.md,reference/,scripts/}` |
| Skills only | `bash skill/plugin/build.sh skill` → `publish-to-aks.skill.zip` | `publish-to-aks/{SKILL.md,reference/,scripts/}` |

Neither zip contains a top-level `bin/`, `tests/` or `tools/`: the skill is scripts plus reference files, nothing
to install. An optional second argument sets the output path.

- `.claude-plugin/plugin.json` — `name` (equals the skill folder name), `version`, `description`. Bump `version`
  when `SKILL.md` or the scripts change.
- `.mcp.json` — registers the `artifacts` MCP server at `https://mcp.corp.com/artifacts-mcp/mcp` (the APIM MCP
  server from DESIGN §6.10). With the skills-only layout this file cannot ship; the connector is then added once
  by a Claude org Owner under Settings → Connectors (integration item I5 in `STATUS.md`).

Test: `bash skill/tests/plugin.test.sh` builds both zips into a temp dir and checks their listings.

No environment variables. `TMPDIR` is honoured for the staging directory.
