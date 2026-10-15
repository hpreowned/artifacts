// Picks the Defender reader and pipeline trigger implementations from the configuration (BACKEND, PIPELINE_TRIGGER).
import type { Config } from "../../intake-api/src/config.js";
import { blobService } from "../../intake-api/src/stores/blob.js";
import { BlobTagDefenderReader, FakeDefenderReader, type DefenderReader } from "./defender.js";
import { AzureDevOpsPipelineTrigger, FakePipelineTrigger, postAwaitingApproval, type PipelineTrigger } from "./pipeline.js";
import type { WorkerOptions } from "./worker.js";

export function createDefenderReader(cfg: Config): DefenderReader {
  if (cfg.backend === "memory") return new FakeDefenderReader(cfg.worker.defenderFakeMalicious);
  const container = blobService(cfg.storageAccountUrl!).getContainerClient(cfg.containers.intake);
  return new BlobTagDefenderReader(container, cfg.worker.defenderTimeoutSeconds, cfg.worker.defenderPollSeconds);
}

/** The fake trigger plays the pipeline's first callback against intake when a pipeline token is configured. */
export function createPipelineTrigger(cfg: Config): PipelineTrigger {
  if (cfg.worker.pipelineTrigger === "ado") {
    const { org, project, pipelineId } = cfg.worker.ado;
    return new AzureDevOpsPipelineTrigger(org!, project!, pipelineId!);
  }
  const callback = cfg.pipelineToken ? postAwaitingApproval(cfg.worker.intakeInternalUrl, cfg.pipelineToken) : undefined;
  if (!callback) console.warn("[worker] PIPELINE_TOKEN is not set: the fake pipeline will not post awaiting_approval");
  return new FakePipelineTrigger(callback);
}

export function workerOptions(cfg: Config): WorkerOptions {
  return {
    gitleaksBin: cfg.worker.gitleaksBin,
    pythonBin: cfg.worker.pythonBin,
    importsScript: cfg.worker.importsScript,
    runtimeManifestPath: cfg.worker.runtimeManifestPath,
    shellOrigin: cfg.shellOrigin,
    approverGroup: cfg.approverGroup,
    // Not part of intake-api's Config (that file is not ours to extend): read directly, same default as the
    // contract (contracts/findings.md JS-002).
    npmRegistryHost: process.env.NPM_REGISTRY_HOST ?? "jfrog.corp.com",
  };
}
