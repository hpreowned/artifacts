#!/usr/bin/env node
// Shim so `npx artifactctl` / a global install resolve to the built entry. Run `npm run build` first.
import("../dist/artifactctl.js").catch((e) => {
  process.stderr.write(`artifactctl: ${e && e.code === "ERR_MODULE_NOT_FOUND" ? "not built; run `npm --prefix cli run build`" : String(e)}\n`);
  process.exit(1);
});
