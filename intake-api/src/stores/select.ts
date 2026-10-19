import type { Config } from "../config.js";
import { BlobBundleStore, BlobJobStore, BlobServingStore, blobService } from "./blob.js";
import { DiskBundleStore, DiskJobStore } from "./disk.js";
import { LocalServingStore, MemoryBundleStore, MemoryJobStore, MemoryScanQueue } from "./memory.js";
import { ServiceBusScanQueue } from "./servicebus.js";
import type { Stores } from "./types.js";

/** BACKEND=memory → in-process stores + local serving directory. BACKEND=disk → the same with job records and
 *  bundles on disk (survives restarts; single process). BACKEND=azure → Blob + Service Bus. */
export function createStores(cfg: Config): Stores {
  if (cfg.backend === "memory") {
    return {
      jobs: new MemoryJobStore(),
      bundles: new MemoryBundleStore(),
      serving: new LocalServingStore(cfg.serveRoot),
      queue: new MemoryScanQueue(),
    };
  }
  if (cfg.backend === "disk") {
    return {
      jobs: new DiskJobStore(cfg.dataRoot),
      bundles: new DiskBundleStore(cfg.dataRoot),
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
