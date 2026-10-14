// Repo root for tests: the first ancestor of the compiled test file that contains contracts/.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function findRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "contracts")) && existsSync(join(dir, "tests", "corpus"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found above " + import.meta.dirname);
}

export const REPO_ROOT = findRoot();
export const CORPUS = join(REPO_ROOT, "tests", "corpus");
