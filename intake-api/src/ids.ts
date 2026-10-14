import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomAlnum(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** `job_` + 20 lowercase alphanumerics, per contracts/intake-openapi.yaml JobId. */
export function newJobId(): string {
  return `job_${randomAlnum(20)}`;
}

/** 12 lowercase alphanumerics, per contracts/intake-openapi.yaml ArtifactId. Becomes the artifact subdomain. */
export function newArtifactId(): string {
  return randomAlnum(12);
}

export const JOB_ID_RE = /^job_[a-z0-9]{20}$/;
export const ARTIFACT_ID_RE = /^[a-z0-9]{12}$/;
