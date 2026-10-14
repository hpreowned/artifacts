// Scanner worker alone (production entrypoint). Consumes the scan queue and runs the static-tier GC.
import { loadConfig } from "../../intake-api/src/config.js";
import { createStores } from "../../intake-api/src/stores/select.js";
import { startGc } from "./gc.js";
import { createDefenderReader, createPipelineTrigger, workerOptions } from "./select.js";
import { startWorker } from "./worker.js";

const cfg = loadConfig();
if (cfg.backend === "memory") console.warn("[worker] BACKEND=memory: this process has its own empty queue; use `npm run dev` in intake-api/ for the local stack");
const stores = createStores(cfg);
const stopWorker = startWorker({ stores, defender: createDefenderReader(cfg), pipeline: createPipelineTrigger(cfg), opts: workerOptions(cfg) });
const stopGc = startGc(stores, cfg.worker.gcIntervalSeconds);
console.log(`[worker] consuming queue "${cfg.scanQueue}" (backend=${cfg.backend}, pipeline=${cfg.worker.pipelineTrigger}, gitleaks=${cfg.worker.gitleaksBin})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopGc();
    stopWorker().finally(() => process.exit(0));
  });
}
