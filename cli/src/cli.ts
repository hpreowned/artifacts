// In-process entry point. `run()` never calls process.exit, so tests and the binary share one code path.
import { parseCommand, USAGE } from "./args.js";
import { ApiError, IntakeClient, NetworkError } from "./client.js";
import { loadConfig, UsageError } from "./config.js";
import { exitCodeFor, formatFinding, formatJson, formatStatus } from "./output.js";
import { locatePreflight, runPreflight } from "./preflight.js";
import { publish } from "./publish.js";

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Injected by tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected by tests so polling does not really wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs one command. Returns the exit code: 0 ok, 1 usage/API error, 2 network, 3 rejected, 4 failed/expired/timeout. */
export async function run(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let cmd;
  try {
    cmd = parseCommand(argv);
  } catch (e) {
    io.stderr(`artifactctl: ${(e as Error).message}\n${USAGE}`);
    return 1;
  }
  if (cmd.kind === "help") {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if (cmd.kind === "preflight") {
      const rc = runPreflight(cmd.dir, locatePreflight(env), io.stdout, io.stderr);
      return rc === 0 ? 0 : rc === 1 ? 3 : 1;
    }
    const client = new IntakeClient(loadConfig(env), io.fetch ?? fetch);
    if (cmd.kind === "status") {
      const s = await client.status(cmd.jobId);
      io.stdout(cmd.json ? formatJson(s) : formatStatus(s));
      return exitCodeFor(s.state);
    }
    const quiet = cmd.json;
    const r = await publish(client, cmd.dir, {
      wait: cmd.wait,
      intervalMs: cmd.intervalMs,
      timeoutMs: cmd.timeoutMs,
      sleep: io.sleep ?? realSleep,
      now: io.now ?? Date.now,
      log: (line) => {
        if (!quiet) io.stderr(`${line}\n`);
      },
    });
    io.stdout(cmd.json ? formatJson(r.status) : formatStatus(r.status));
    if (r.timedOut) {
      io.stderr(`artifactctl: timed out after ${cmd.timeoutMs / 1000}s; job ${r.status.jobId} is still ${r.status.state}. ` +
        `Check later with: artifactctl status ${r.status.jobId}\n`);
      return exitCodeFor("timeout");
    }
    return exitCodeFor(r.status.state);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`artifactctl: ${e.message}\n`);
      return 1;
    }
    if (e instanceof NetworkError) {
      io.stderr(`artifactctl: network: ${e.message}\n`);
      return 2;
    }
    if (e instanceof ApiError) {
      io.stderr(`artifactctl: ${e.message}\n`);
      for (const f of e.findings) io.stderr(`${formatFinding(f)}\n`);
      return 1;
    }
    throw e;
  }
}
