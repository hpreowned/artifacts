# Job states

One job per `beginPublish`. One artifact id per job. States and who moves them:

| From | To | Who | Trigger |
|---|---|---|---|
| (new) | awaiting_upload | intake-api | beginPublish |
| awaiting_upload | scanning | intake-api | finalize with matching sha256 |
| awaiting_upload | expired | intake-api | 10 min without finalize |
| scanning | rejected | scanner worker | any `deny` finding (policy.ts) |
| scanning | deploying | scanner worker | tier static, verdict pass |
| scanning | awaiting_approval | Azure DevOps pipeline via /events | tier python/node, verdict pass, approval policy decided `human` (a warning finding, D16): the run targets the environment with the approval check |
| scanning | deploying | Azure DevOps pipeline via /events | tier python/node, verdict pass, approval policy decided `auto` (clean scan, D16): the run targets the environment without checks and deploys directly |
| scanning | failed | scanner worker | internal error, Defender result `Error`, pipeline trigger failed |
| scanning | failed | scanner worker | python job: `runUrl` set but no `/events` callback within `PIPELINE_TIMEOUT_HOURS` (default 24) |
| awaiting_approval | deploying | pipeline via /events | approval granted |
| awaiting_approval | rejected | pipeline via /events | approval declined |
| awaiting_approval | expired | pipeline via /events | approval check timed out (7 days) | Note: until T52, the pipeline posts `rejected` for a timeout too, with a message pointing at the Checks tab, because Azure DevOps exposes both as a skipped stage. |
| deploying | live | scanner worker (static) / pipeline via /events (python) | files in serving/ (static); rollout healthy (python) |
| deploying | failed | scanner worker / pipeline | copy or rollout error |
| live | expired | artifact-gc pipeline via /events (python) / scanner worker GC (static) | TTL reached |

Terminal: rejected, failed, expired. `live` is terminal for the publisher; it ends in `expired`.

Defender for Storage result handling at stage 3: `Malicious` → rejected with MAL-001. `No threats found` → continue. `Error`, `Not scanned`, or no result within 60 s → `failed` with MAL-002 and a message that asks for a resubmit; never auto-allow.

The node tier (`tier: node`, DESIGN D14/§6.13) uses the python tier's transitions verbatim; its pipeline is `artifact-node-deploy` and its TTL maximum is 30 days.
