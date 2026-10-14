// `npm run dev`: the whole publish path on a laptop. Memory backends, DEV_AUTH=1, fake Defender and pipeline,
// files served from SERVE_ROOT. Secrets that are not in the environment are generated and printed once.
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { startLocalStack } from "./stack.js";

process.env.DEV_AUTH = "1";
process.env.BACKEND = "memory";
const generated: string[] = [];
for (const name of ["VIEW_TOKEN_KEY", "PIPELINE_TOKEN", "INTERNAL_SHARED_KEY"]) {
  if (!process.env[name]) {
    process.env[name] = randomBytes(32).toString("base64");
    generated.push(name);
  }
}

const cfg = loadConfig();
const stack = await startLocalStack(cfg);
console.log(`[dev] intake API + scanner worker on ${stack.baseUrl} (DEV_AUTH=1, memory backends)`);
console.log(`[dev] serving static artifacts from ${cfg.serveRoot}; live URLs use SHELL_ORIGIN=${cfg.shellOrigin}`);
console.log(`[dev] fake pipeline posts awaiting_approval for python jobs; DEFENDER_FAKE_MALICIOUS=${[...cfg.worker.defenderFakeMalicious].join(",") || "(none)"}`);
for (const name of generated) console.log(`[dev] generated ${name}=${process.env[name]}  (export it so the gateway, shell or pipeline fakes can talk to this stack)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stack.stop().finally(() => process.exit(0));
  });
}
