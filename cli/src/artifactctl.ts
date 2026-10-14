#!/usr/bin/env node
// Executable entry: `node cli/dist/artifactctl.js <command> ...`. All logic lives in cli.ts.
import { run } from "./cli.js";

const code = await run(process.argv.slice(2), process.env, {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
});
process.exitCode = code;
