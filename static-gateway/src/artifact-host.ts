const ARTIFACT_ID = /^[a-z0-9]{12}$/;

/** Returns the artifact id when `host` is exactly `<id>.<artifactDomain>`; otherwise null. */
export function artifactIdFromHost(host: string | undefined, artifactDomain: string): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  const suffix = `.${artifactDomain}`;
  if (!h.endsWith(suffix)) return null;
  const id = h.slice(0, -suffix.length);
  return ARTIFACT_ID.test(id) ? id : null;
}

export function isArtifactId(value: string): boolean {
  return ARTIFACT_ID.test(value);
}
