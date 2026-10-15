// intake-api alone (production entrypoint). The worker runs separately: scanner/src/main.ts.
import { loadConfig } from "./config.js";
import { createEntraTokenVerifier } from "./entra-token.js";
import { startExpirySweeper } from "./expiry.js";
import { createApp } from "./server.js";
import { createStores } from "./stores/select.js";

const cfg = loadConfig();
if (!cfg.pipelineToken) console.warn("[intake] PIPELINE_TOKEN is not set: /events will answer 401");
if (!cfg.internalSharedKey) console.warn("[intake] INTERNAL_SHARED_KEY is not set: /view-token will answer 401");
if (cfg.backend === "memory") console.warn("[intake] BACKEND=memory: jobs live in this process only; use `npm run dev` for the full local stack");
if (!process.env.VIEW_TOKEN_KEY) console.warn("[intake] VIEW_TOKEN_KEY is not set: generated a random key; gateway and shell cannot verify view tokens");
// T18: with DEV_AUTH=1, X-Publisher-* headers are trusted as-is and any bearer is accepted. Never set this in production.
if (cfg.devAuth) console.warn("[intake] DEV_AUTH=1: X-Publisher-Oid/-Upn are trusted unverified and any bearer is accepted. Local development only.");

const stores = createStores(cfg);
const stopSweeper = startExpirySweeper(stores.jobs, cfg.uploadExpirySweepSeconds);
// loadConfig() already refused to start without ENTRA_TENANT_ID/ENTRA_AUDIENCE unless devAuth is set.
const entraVerifier = cfg.devAuth ? undefined : createEntraTokenVerifier({ tenantId: cfg.entraTenantId!, audience: cfg.entraAudience!, requiredScope: cfg.entraRequiredScope });
const server = createApp({ cfg, stores, now: () => new Date(), entraVerifier });
server.listen(cfg.port, process.env.HOST ?? "0.0.0.0", () => console.log(`[intake] listening on :${cfg.port} (backend=${cfg.backend}, devAuth=${cfg.devAuth})`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopSweeper();
    server.close(() => process.exit(0));
  });
}
