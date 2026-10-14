import type { Config } from "../config.js";
import { BlobBundleStore, BlobJobStore, BlobServingStore, blobService } from "./blob.js";
import { LocalServingStore, MemoryBundleStore, MemoryJobStore, MemoryScanQueue } from "./memory.js";
import { ServiceBusScanQueue } from "./servicebus.js";
import type { Stores } from "./types.js";

/** BACKEND=memory → in-process stores + local serving directory. BACKEND=azure → Blob + Service Bus. */
export function createStores(cfg: Config): Stores {
  if (cfg.backend === "memory") {
    return {
      jobs: new MemoryJobStore(),
      bundles: new MemoryBundleStore(),
      serving: new LocalServingStore(cfg.serveRoot),
      queue: new MemoryScanQueue(),
    };
  }
  const service = blobService(cfg.storageAccountUrl!);
  return {
    jobs: new BlobJobStore(service.getContainerClient(cfg.containers.jobs)),
    bundles: new BlobBundleStore(service.getContainerClient(cfg.containers.intake)),
    serving: new BlobServingStore(service.getContainerClient(cfg.containers.serving)),
    queue: new ServiceBusScanQueue(cfg.serviceBusFqdn!, cfg.scanQueue),
  };
}
