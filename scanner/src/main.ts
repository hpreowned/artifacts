// Scanner worker alone (production entrypoint). Consumes the scan queue, runs the maintenance loop (static-tier
// GC and the python pipeline-timeout sweep, both in gc.ts), and answers /healthz on HEALTH_PORT (T17).
import { int, loadConfig } from "../../intake-api/src/config.js";
import { createStores } from "../../intake-api/src/stores/select.js";
import { startGc } from "./gc.js";
import { HealthState, startHealthServer } from "./health.js";
import { createDefenderReader, createPipelineTrigger, workerOptions } from "./select.js";
import { startWorker } from "./worker.js";

const cfg = loadConfig();
if (cfg.backend === "memory") console.warn("[worker] BACKEND=memory: this process has its own empty queue; use `npm run dev` in intake-api/ for the local stack");
const pipelineTimeoutHours = int(process.env.PIPELINE_TIMEOUT_HOURS, 24);
const healthPort = int(process.env.HEALTH_PORT, 8081);

const stores = createStores(cfg);
const health = new HealthState(cfg.backend === "memory" ? "memory" : "servicebus");
const healthServer = startHealthServer(healthPort, health);
const stopWorker = startWorker({ stores, defender: createDefenderReader(cfg), pipeline: createPipelineTrigger(cfg), opts: workerOptions(cfg) });
const stopGc = startGc(stores, cfg.worker.gcIntervalSeconds, pipelineTimeoutHours);
console.log(
  `[worker] consuming queue "${cfg.scanQueue}" (backend=${cfg.backend}, pipeline=${cfg.worker.pipelineTrigger}, gitleaks=${cfg.worker.gitleaksBin}); ` +
    `/healthz on ${healthPort}; pipeline timeout ${pipelineTimeoutHours}h`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    health.markDown();
    stopGc();
    stopWorker().finally(() => healthServer.close(() => process.exit(0)));
  });
}
