import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pythonChecks } from "../python-stage.js";
import { IMPORTS_SCRIPT, RUNTIME_MANIFEST } from "./helpers.js";

const opts = { pythonBin: "python3", importsScript: IMPORTS_SCRIPT, runtimeManifestPath: RUNTIME_MANIFEST };

async function check(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "py-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), body);
    }
    return (await pythonChecks(dir, opts)).map((f) => `${f.rule}@${f.line}`).sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("PY-001: imports outside stdlib and the runtime; local and relative modules are fine", async () => {
  assert.deepEqual(await check({ "app.py": "import requests\nimport pandas.io\nfrom numpy import array\nimport json, os.path\n" }), ["PY-001@1"]);
  assert.deepEqual(await check({ "app.py": "import utils\nfrom helpers import x\nfrom . import sibling\n", "utils.py": "", "helpers.py": "" }), []);
  assert.deepEqual(await check({ "app.py": "from pkg.mod import f\n", "pkg/__init__.py": "", "pkg/mod.py": "" }), []);
});

test("PY-002: dangerous modules, os process functions, builtins, in every spelling", async () => {
  assert.deepEqual(await check({ "app.py": "import subprocess\n" }), ["PY-002@1"]);
  assert.deepEqual(await check({ "app.py": "import os\nos.system('id')\n" }), ["PY-002@2"]);
  assert.deepEqual(await check({ "app.py": "import os as o\no.execv('/bin/sh', [])\n" }), ["PY-002@2"]);
  assert.deepEqual(await check({ "app.py": "from os import system as s\ns('id')\n" }), ["PY-002@1", "PY-002@2"]);
  assert.deepEqual(await check({ "app.py": "import os\nf = os.fork\n" }), ["PY-002@2"]);
  assert.deepEqual(await check({ "app.py": "eval('1')\nexec('x=1')\n__import__('os')\ncompile('1', 'f', 'eval')\n" }), ["PY-002@1", "PY-002@2", "PY-002@3", "PY-002@4"]);
  assert.deepEqual(await check({ "app.py": "import importlib\nimport ctypes, pickle, marshal, socket\n" }), ["PY-002@1", "PY-002@2", "PY-002@2", "PY-002@2", "PY-002@2"]);
  assert.deepEqual(await check({ "app.py": "import os\nprint(os.getcwd(), os.environ.get('X'))\n" }), []);
});

test("PY-003: writes outside /tmp, through open() and pathlib", async () => {
  assert.deepEqual(await check({ "app.py": "open('/app/out.txt', 'w').write('x')\n" }), ["PY-003@1"]);
  assert.deepEqual(await check({ "app.py": "with open('out.txt', mode='a') as f:\n    pass\n" }), ["PY-003@1"]);
  assert.deepEqual(await check({ "app.py": "open('/tmp/out.txt', 'w')\nopen('/app/data.csv')\nopen('/app/data.csv', 'rb')\n" }), []);
  assert.deepEqual(await check({ "app.py": "OUT = '/tmp/o.txt'\nopen(OUT, 'w')\n" }), []);
  assert.deepEqual(await check({ "app.py": "import os\nopen(os.path.join('/tmp', 'x'), 'w')\nopen(os.path.join('/app', 'x'), 'w')\n" }), ["PY-003@3"]);
  assert.deepEqual(await check({ "app.py": "import tempfile\nopen(tempfile.mktemp(), 'w')\n" }), []);
  assert.deepEqual(await check({ "app.py": "def save(p):\n    open(p, 'w')\n" }), ["PY-003@2"]);
  assert.deepEqual(await check({ "app.py": "from pathlib import Path\nPath('/app/x').write_text('a')\n(Path('/tmp') / 'y').write_text('b')\nPath('/data/z').open('w')\nPath('/data/z').read_text()\n" }), ["PY-003@2", "PY-003@4"]);
  assert.deepEqual(await check({ "app.py": "import pathlib\npathlib.Path('/var/x').touch()\n" }), ["PY-003@2"]);
});

test("PY-005: threading and asyncio are warnings", async () => {
  assert.deepEqual(await check({ "app.py": "import threading\nimport asyncio\nfrom concurrent.futures import ThreadPoolExecutor\n" }), ["PY-005@1", "PY-005@2", "PY-005@3"]);
});

test("a file that does not parse is reported under its own rule, not crashed on", async () => {
  assert.deepEqual(await check({ "app.py": "def broken(:\n    pass\n" }), ["PY-006@1"]);
});

test("a broken scanner invocation throws so the job fails rather than passes", async () => {
  await assert.rejects(() => pythonChecks("/nonexistent-dir", opts), /imports.py exited/);
  await assert.rejects(() => pythonChecks(".", { ...opts, pythonBin: "/nonexistent/python3" }), /could not start/);
});
