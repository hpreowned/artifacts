// intake-api alone (production entrypoint). The worker runs separately: scanner/src/main.ts.
import { loadConfig } from "./config.js";
import { startExpirySweeper } from "./expiry.js";
import { createApp } from "./server.js";
import { createStores } from "./stores/select.js";

const cfg = loadConfig();
if (!cfg.pipelineToken) console.warn("[intake] PIPELINE_TOKEN is not set: /events will answer 401");
if (!cfg.internalSharedKey) console.warn("[intake] INTERNAL_SHARED_KEY is not set: /view-token will answer 401");
if (cfg.backend === "memory") console.warn("[intake] BACKEND=memory: jobs live in this process only; use `npm run dev` for the full local stack");
if (!process.env.VIEW_TOKEN_KEY) console.warn("[intake] VIEW_TOKEN_KEY is not set: generated a random key; gateway and shell cannot verify view tokens");

const stores = createStores(cfg);
const stopSweeper = startExpirySweeper(stores.jobs, cfg.uploadExpirySweepSeconds);
const server = createApp({ cfg, stores, now: () => new Date() });
server.listen(cfg.port, () => console.log(`[intake] listening on :${cfg.port} (backend=${cfg.backend}, devAuth=${cfg.devAuth})`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopSweeper();
    server.close(() => process.exit(0));
  });
}
