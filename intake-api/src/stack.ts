// The local stack: API + worker + GC + upload-expiry sweeper in one process on memory backends. Used by
// `npm run dev` (dev.ts) and by the end-to-end test, so both exercise the same composition.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeDefenderReader } from "../../scanner/src/defender.js";
import { startGc } from "../../scanner/src/gc.js";
import { FakePipelineTrigger, postFakeCallbacks } from "../../scanner/src/pipeline.js";
import { workerOptions } from "../../scanner/src/select.js";
import { startWorker } from "../../scanner/src/worker.js";
import type { Config } from "./config.js";
import { createEntraTokenVerifier } from "./entra-token.js";
import { startExpirySweeper } from "./expiry.js";
import { createApp } from "./server.js";
import { createStores } from "./stores/select.js";
import type { Stores } from "./stores/types.js";

export interface LocalStack {
  cfg: Config;
  server: Server;
  port: number;
  baseUrl: string;
  stores: Stores;
  defender: FakeDefenderReader;
  pipeline: FakePipelineTrigger;
  stop(): Promise<void>;
}

// Binds all interfaces unless HOST says otherwise: scripts/dev-env.sh sets HOST=127.0.0.1 so a laptop stays
// loopback-only, while in a pod the readiness probe and the Service arrive over the pod network.
export async function startLocalStack(cfg: Config, port: number = cfg.port): Promise<LocalStack> {
  if (cfg.backend !== "memory" && cfg.backend !== "disk") throw new Error("the local stack runs on BACKEND=memory or BACKEND=disk only");
  if (!cfg.pipelineToken) throw new Error("the local stack needs PIPELINE_TOKEN so the fake pipeline can call /events");
  const stores = createStores(cfg);
  const entraVerifier = cfg.devAuth ? undefined : createEntraTokenVerifier({ tenantId: cfg.entraTenantId!, audience: cfg.entraAudience!, requiredScope: cfg.entraRequiredScope });
  const server = createApp({ cfg, stores, now: () => new Date(), entraVerifier });
  await new Promise<void>((resolve, reject) => server.listen(port, process.env.HOST ?? "0.0.0.0").once("listening", resolve).once("error", reject));
  const bound = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${bound}`;
  const defender = new FakeDefenderReader(cfg.worker.defenderFakeMalicious);
  // PIPELINE_TRIGGER=manual (dev cluster): the run URL still points at the dev page, but nothing is played —
  // an operator runs scripts/play-node-pipeline.sh, which posts the callbacks the real pipeline would.
  const callbacks = cfg.worker.pipelineTrigger === "manual" ? undefined : postFakeCallbacks(baseUrl, cfg.pipelineToken);
  const pipeline = new FakePipelineTrigger(callbacks, `${cfg.publicBaseUrl}/dev/approval`);
  const stopWorker = startWorker({ stores, defender, pipeline, opts: workerOptions(cfg) });
  const stopGc = startGc(stores, cfg.worker.gcIntervalSeconds);
  const stopSweeper = startExpirySweeper(stores.jobs, cfg.uploadExpirySweepSeconds);
  return {
    cfg, server, port: bound, baseUrl, stores, defender, pipeline,
    stop: async () => {
      stopGc();
      stopSweeper();
      await stopWorker();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
