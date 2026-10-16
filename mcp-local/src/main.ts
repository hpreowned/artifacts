// Local stdio MCP server for Claude Code. Fronts the local intake API (tests/dev-stack.sh) with the same two
// tools APIM publishes in production, so the publish-to-aks skill can be exercised end to end with no Azure.
//
// Register it with:  claude mcp add artifacts -- node <repo>/mcp-local/dist/mcp-local/src/main.js
// Environment: ARTIFACTS_API_URL (default http://localhost:8080), ARTIFACTS_DEV_OID (default local-dev),
// ARTIFACTS_TOKEN (any value in dev).
import { createInterface } from "node:readline";
import { IntakeClient } from "../../cli/src/client.js";
import { loadConfig } from "../../cli/src/config.js";
import { handle, log } from "./protocol.js";
import { tools } from "./tools.js";

const env = { ARTIFACTS_DEV_OID: "local-dev", ...process.env };
const cfg = loadConfig(env);
const list = tools(new IntakeClient(cfg));
const dispatch = handle(list, "artifacts-local");

log(`ready: ${list.map((t) => t.name).join(", ")} -> ${cfg.apiUrl} (publisher ${env.ARTIFACTS_DEV_OID})`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  void dispatch(line).then((res) => {
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
});
rl.on("close", () => process.exit(0));
