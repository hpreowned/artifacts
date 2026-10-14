// Resolves the repository root so both packages can find contracts/ and scanner/src/python/imports.py.
// Both packages compile with rootDir ".." into <pkg>/dist/<repo-relative path>, so from any compiled
// module the repo root is a fixed number of levels up. Override with REPO_ROOT (e.g. in a container).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/intake-api/src
export const REPO_ROOT: string = process.env.REPO_ROOT ?? resolve(here, "..", "..", "..", "..");
export const MANIFEST_SCHEMA_PATH: string = process.env.MANIFEST_SCHEMA ?? resolve(REPO_ROOT, "contracts", "manifest.schema.json");
