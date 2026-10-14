// Argument parsing with node:util parseArgs. No dependencies.
import { parseArgs } from "node:util";
import { UsageError } from "./config.js";

export const USAGE = `usage:
  artifactctl preflight <dir>
  artifactctl publish <dir> [--wait] [--interval <seconds>] [--timeout <seconds>] [--json]
  artifactctl status <jobId> [--json]

environment:
  ARTIFACTS_API_URL   base URL of the intake API (default http://localhost:8080)
  ARTIFACTS_TOKEN     bearer for the API (Entra token in production; any value in dev)
  ARTIFACTS_DEV_OID   dev only: sent as X-Publisher-Oid / X-Publisher-Upn (<oid>@dev)
  ARTIFACTS_PREFLIGHT path to preflight.sh (default: skill/publish-to-aks/scripts/preflight.sh in this repo)

exit codes: 0 live or awaiting_approval, 3 rejected, 4 failed/expired/timeout, 2 network, 1 usage or API error
`;

export type Command =
  | { kind: "help" }
  | { kind: "preflight"; dir: string }
  | { kind: "publish"; dir: string; wait: boolean; intervalMs: number; timeoutMs: number; json: boolean }
  | { kind: "status"; jobId: string; json: boolean };

function seconds(name: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number of seconds`);
  return n * 1000;
}

export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        wait: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        interval: { type: "string" },
        timeout: { type: "string" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [cmd, arg, extra] = positionals;
  if (values.help || !cmd) return { kind: "help" };
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  switch (cmd) {
    case "preflight":
      if (!arg) throw new UsageError("preflight needs a directory");
      return { kind: "preflight", dir: arg };
    case "publish":
      if (!arg) throw new UsageError("publish needs a directory");
      return {
        kind: "publish",
        dir: arg,
        wait: values.wait,
        intervalMs: seconds("interval", values.interval, 10),
        timeoutMs: seconds("timeout", values.timeout, 600),
        json: values.json,
      };
    case "status":
      if (!arg) throw new UsageError("status needs a jobId");
      return { kind: "status", jobId: arg, json: values.json };
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}
