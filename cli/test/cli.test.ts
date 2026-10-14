import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { run, type Io } from "../src/cli.js";
import type { Status } from "../src/client.js";
import { FakeIntake, LIVE } from "./fake-intake.js";
import { CORPUS } from "./paths.js";
import { unzip } from "./unzip.js";

const fake = new FakeIntake();
let env: NodeJS.ProcessEnv;
before(async () => {
  const base = await fake.listen();
  env = { ARTIFACTS_API_URL: base, ARTIFACTS_TOKEN: "entra-token-for-tests", ARTIFACTS_DEV_OID: "dev-user", PATH: process.env.PATH };
});
after(() => fake.close());
beforeEach(() => {
  fake.scenario = LIVE;
  fake.mode = "ok";
  fake.findingsOn400 = true;
  fake.requests.length = 0;
  fake.jobs.clear();
});

interface Capture extends Io {
  out: string;
  err: string;
  sleeps: number[];
}

/** Virtual clock: sleep advances `now` instead of waiting. */
function capture(): Capture {
  let clock = 0;
  const c: Capture = {
    out: "",
    err: "",
    sleeps: [],
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    sleep: async (ms) => {
      c.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return c;
}

const exec = (argv: string[], io = capture(), e = env): Promise<[number, Capture]> => run(argv, e, io).then((code) => [code, io]);
const bundle = (name: string): string => join(CORPUS, name);
const json = (io: Capture): Status => JSON.parse(io.out) as Status;

describe("publish --wait", () => {
  it("static-ok goes live: exit 0, url and expiry printed, the API saw the contract flow", async () => {
    const [code, io] = await exec(["publish", "--wait", bundle("static-ok")]);
    assert.equal(code, 0, io.err);
    assert.match(io.out, /^job      job_[a-z0-9]{20}\nstate    live\nurl      https:\/\/x1y2z3a4b5c6\.artifacts\.corp\.internal\/\nexpires  2026-10-28T00:00:00Z\nsummary  Static artifact is live\.\n$/);
    assert.match(io.err, /bundle: 3 files, \d+ bytes, sha256 [a-f0-9]{64}\njob job_\w+: uploading .*\njob job_\w+: scanning\njob job_\w+: deploying\njob job_\w+: live\n/);
    assert.deepEqual(io.sleeps, [10_000, 10_000], "polled every --interval (default 10 s) between scanning, deploying, live");

    const [begin, upload, finalize, ...polls] = fake.requests;
    assert.equal(begin?.method, "POST");
    assert.equal(begin?.path, "/v1/publish");
    assert.equal(begin?.headers.authorization, "Bearer entra-token-for-tests");
    assert.equal(begin?.headers["x-publisher-oid"], "dev-user");
    assert.equal(begin?.headers["x-publisher-upn"], "dev-user@dev");
    assert.equal(begin?.headers["content-type"], "application/json");
    assert.equal((JSON.parse(begin?.body.toString() ?? "") as { name: string }).name, "q3-sales");

    const job = [...fake.jobs.values()][0];
    assert.ok(job);
    assert.equal(upload?.method, "PUT");
    assert.equal(upload?.path, `/v1/publish/${job.id}/upload?sig=abc`);
    assert.equal(upload?.headers.authorization, `Bearer ${job.uploadToken}`);
    assert.equal(upload?.headers["content-type"], "application/zip");
    assert.equal(upload?.headers["x-publisher-oid"], undefined, "upload uses only the one-time token");
    const entries = unzip(upload?.body ?? Buffer.alloc(0));
    assert.deepEqual(entries.map((e) => e.name), ["expected.json", "index.html", "manifest.json"]);
    for (const e of entries) assert.deepEqual(e.data, readFileSync(join(CORPUS, "static-ok", e.name)));

    assert.equal(finalize?.method, "POST");
    assert.equal(finalize?.path, `/v1/publish/${job.id}/finalize`, "query string dropped, /upload swapped for /finalize");
    assert.equal(finalize?.headers.authorization, `Bearer ${job.uploadToken}`);
    assert.equal(polls.length, 3);
    for (const p of polls) {
      assert.equal(p.method, "GET");
      assert.equal(p.path, `/v1/publish/${job.id}`);
      assert.equal(p.headers.authorization, "Bearer entra-token-for-tests");
    }
  });

  it("rejected: exit 3, findings as RULE file:line message, --json carries the Status", async () => {
    fake.scenario = { states: ["scanning", "rejected"], findings: [{ rule: "HTML-005", severity: "deny", file: "index.html", line: 10, message: "password input" }], summary: "Rejected." };
    const [code, io] = await exec(["publish", "--wait", bundle("static-password")]);
    assert.equal(code, 3);
    assert.match(io.out, /state    rejected\nsummary  Rejected\.\nHTML-005 index\.html:10 password input\n$/);
    const [jcode, jio] = await exec(["publish", "--wait", "--json", bundle("static-password")]);
    assert.equal(jcode, 3);
    assert.equal(jio.err, "", "--json keeps stderr clean");
    assert.equal(json(jio).state, "rejected");
    assert.deepEqual(json(jio).findings?.map((f) => f.rule), ["HTML-005"]);
  });

  it("live with info findings (static-fetch) still exits 0 and lists them", async () => {
    fake.scenario = { ...LIVE, findings: [{ rule: "HTML-009", severity: "info", file: "index.html", line: 7, message: "fetch is blocked" }] };
    const [code, io] = await exec(["publish", "--wait", bundle("static-fetch")]);
    assert.equal(code, 0);
    assert.match(io.out, /HTML-009 index\.html:7 \(info\) fetch is blocked\n/);
  });

  it("awaiting_approval (python-ok): exit 0 with the run link and group", async () => {
    fake.scenario = { states: ["scanning", "awaiting_approval"], approval: { group: "artifacts-approvers", runUrl: "https://dev.azure.com/corp/artifacts/_build/results?buildId=42" } };
    const [code, io] = await exec(["publish", "--wait", bundle("python-ok")]);
    assert.equal(code, 0);
    assert.match(io.out, /state    awaiting_approval\nrun      https:\/\/dev\.azure\.com\/corp\/artifacts\/_build\/results\?buildId=42\ngroup    artifacts-approvers\n/);
    assert.equal(fake.requests.filter((r) => r.method === "GET").length, 2, "stops polling at awaiting_approval");
  });

  it("failed and expired exit 4", async () => {
    fake.scenario = { states: ["failed"], findings: [{ rule: "MAL-002", severity: "deny", message: "scan timed out; resubmit" }] };
    const [f, fio] = await exec(["publish", "--wait", bundle("static-ok")]);
    assert.equal(f, 4);
    assert.match(fio.out, /MAL-002 - scan timed out; resubmit/);
    fake.scenario = { states: ["expired"] };
    assert.equal((await exec(["publish", "--wait", bundle("static-ok")]))[0], 4);
  });

  it("timeout: exit 4 after --timeout with a hint to check status later", async () => {
    fake.scenario = { states: ["scanning"] };
    const [code, io] = await exec(["publish", "--wait", "--interval", "10", "--timeout", "25", bundle("static-ok")]);
    assert.equal(code, 4);
    assert.deepEqual(io.sleeps, [10_000, 10_000, 10_000]);
    assert.equal(fake.requests.filter((r) => r.method === "GET").length, 4);
    assert.match(io.out, /state    scanning\n/);
    assert.match(io.err, /timed out after 25s; job job_\w+ is still scanning\. Check later with: artifactctl status job_\w+\n/);
  });

  it("without --wait prints the queued status and exits 0 without polling", async () => {
    const [code, io] = await exec(["publish", "--json", bundle("static-ok")]);
    assert.equal(code, 0);
    assert.equal(json(io).state, "scanning");
    assert.equal(fake.requests.filter((r) => r.method === "GET").length, 0);
  });

  it("400 at beginPublish is reported as rejected with the server's findings, or IN-006 when it sent none", async () => {
    const [code, io] = await exec(["publish", "--wait", "--json", bundle("static-bad-manifest")]);
    assert.equal(code, 3);
    assert.equal(json(io).state, "rejected");
    assert.deepEqual(json(io).findings?.map((f) => f.rule), ["IN-006"]);
    assert.equal(fake.requests.length, 1, "no upload after a refused manifest");
    fake.findingsOn400 = false;
    const [code2, io2] = await exec(["publish", "--wait", "--json", bundle("static-bad-manifest")]);
    assert.equal(code2, 3);
    assert.deepEqual(json(io2).findings?.map((f) => [f.rule, f.file]), [["IN-006", "manifest.json"]]);
  });

  it("bundle problems caught locally exit 1 before any request", async () => {
    const [code, io] = await exec(["publish", join(CORPUS, "nope")]);
    assert.equal(code, 1);
    assert.match(io.err, /not a directory/);
    assert.equal(fake.requests.length, 0);
  });

  it("bundle over maxBytes exits 1 without uploading (IN-001)", async () => {
    fake.maxBytes = 10;
    try {
      const [code, io] = await exec(["publish", bundle("static-ok")]);
      assert.equal(code, 1);
      assert.match(io.err, /IN-001/);
      assert.equal(fake.requests.length, 1);
    } finally {
      fake.maxBytes = 26_214_400;
    }
  });
});

describe("network", () => {
  it("HTTP 403 from a proxy exits 2", async () => {
    fake.mode = "forbidden";
    const [code, io] = await exec(["publish", bundle("static-ok")]);
    assert.equal(code, 2);
    assert.match(io.err, /network: HTTP 403/);
  });

  it("connection refused exits 2", async () => {
    const [code, io] = await exec(["status", "job_abcdefghij0123456789"], capture(), { ...env, ARTIFACTS_API_URL: "http://127.0.0.1:9" });
    assert.equal(code, 2);
    assert.match(io.err, /network: cannot reach/);
  });
});

describe("status", () => {
  it("reports a job by id with the state's exit code; unknown job exits 1", async () => {
    fake.scenario = { states: ["rejected"], findings: [{ rule: "SEC-001", severity: "deny", file: "index.html", line: 3, message: "AWS key" }] };
    await exec(["publish", bundle("static-secret")]);
    const id = [...fake.jobs.keys()][0] ?? "";
    const [code, io] = await exec(["status", id]);
    assert.equal(code, 3);
    assert.match(io.out, /SEC-001 index\.html:3 AWS key/);
    const [jcode, jio] = await exec(["status", "--json", id]);
    assert.equal(jcode, 3);
    assert.equal(json(jio).jobId, id);
    const [missing, mio] = await exec(["status", "job_zzzzzzzzzzzzzzzzzzzz"]);
    assert.equal(missing, 1);
    assert.match(mio.err, /not found/);
  });
});

describe("preflight", () => {
  it("runs the skill's preflight.sh: clean bundle 0, findings 3", async () => {
    const [ok, oio] = await exec(["preflight", bundle("static-ok")]);
    assert.equal(ok, 0, oio.err);
    assert.equal(oio.out, "");
    const [bad, bio] = await exec(["preflight", bundle("static-password")]);
    assert.equal(bad, 3);
    assert.match(bio.out, /^HTML-005 index\.html:\d+ /m);
    const [missing, mio] = await exec(["preflight", bundle("static-ok")], capture(), { ...env, ARTIFACTS_PREFLIGHT: "/nonexistent/preflight.sh" });
    assert.equal(missing, 1);
    assert.match(mio.err, /ARTIFACTS_PREFLIGHT not found/);
  });
});

describe("usage", () => {
  it("help exits 0; unknown command, missing args and missing token exit 1", async () => {
    const [h, hio] = await exec([]);
    assert.equal(h, 0);
    assert.match(hio.out, /^usage:/);
    assert.equal((await exec(["frobnicate"]))[0], 1);
    assert.equal((await exec(["publish"]))[0], 1);
    const [t, tio] = await exec(["status", "job_abcdefghij0123456789"], capture(), { ARTIFACTS_API_URL: env.ARTIFACTS_API_URL });
    assert.equal(t, 1);
    assert.match(tio.err, /ARTIFACTS_TOKEN/);
    assert.equal(fake.requests.length, 0);
  });
});
