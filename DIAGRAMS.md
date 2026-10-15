# Publish-to-AKS walkthrough: diagrams

Mermaid source for every figure. Paste a block into mermaid.live, Confluence, Azure DevOps wiki, or any Mermaid-capable renderer. Generated 2026-10-14 from the same source as the published walkthrough page.

## Figure 1. Who is involved

*Seventeen actors, four of them people, in five layers. Everything inside the private cluster is invisible to the publisher; they talk only to Cowork.*

Management version: an employee asks Cowork to publish. Cowork does the packaging and talks to one front door. Behind that door, the platform scans and decides. Static pages go straight to hosting. Python apps go through the same Azure DevOps pipeline and approval flow every other deployment in the organisation already uses. A colleague opens a link and signs in with their normal corporate account.

```mermaid
flowchart TB
  subgraph people ["People"]
    PUB["Publisher<br/>an employee using Cowork"]
    APR["Approver<br/>member of the artifacts-approvers group"]
    VIEW["Viewer<br/>a colleague with the link"]
    PLAT["Platform team<br/>runs pipeline, policies, runtime image, skill"]
  end
  subgraph claude ["Claude side, operated by Anthropic"]
    COWORK["Cowork agent<br/>loads the publish-to-aks skill"]
    SANDBOX["Cowork sandbox<br/>runs upload.sh"]
    CONN["Connector service<br/>makes the MCP tool calls"]
  end
  subgraph edge ["Azure edge: the only public surface"]
    APPGW["Application Gateway WAF"]
    APIM["API Management<br/>MCP server, Entra validation, rate limits"]
    ENTRA["Entra ID"]
  end
  subgraph cicd ["Azure DevOps, your existing CI/CD"]
    ADO["Pipeline artifact-python-deploy<br/>gitleaks policy, Sonar advisory, Environment approval,<br/>helm upgrade via the AKS service connection"]
  end
  subgraph aks ["Private AKS cluster"]
    INTAKE["Intake API<br/>orchestrates every job"]
    SCAN["Scanner worker<br/>gitleaks, rule checks, import allowlist, verdict"]
    STATIC["Static gateway<br/>serves HTML artifacts"]
    DYN["Python runtime pods<br/>no network, no identity"]
    SHELL["Viewer shell<br/>Entra sign-in, audit log, iframe"]
  end
  BLOB[("Blob Storage<br/>intake, serving, job state<br/>Defender for Storage malware scan on upload")]

  PUB -->|"publish this internally"| COWORK
  COWORK -->|"tool call"| CONN
  COWORK -->|"runs script"| SANDBOX
  CONN -->|"HTTPS, Entra token"| APPGW
  SANDBOX -->|"HTTPS, one-time token"| APPGW
  APPGW --> APIM
  APIM -.->|"validates token"| ENTRA
  APIM --> INTAKE
  INTAKE -->|"queues scan"| SCAN
  INTAKE --> BLOB
  SCAN --> BLOB
  SCAN -->|"static: copy to serving"| STATIC
  SCAN -->|"python: trigger pipeline run"| ADO
  ADO -->|"after approval, applies manifests"| DYN
  APR -->|"approves in Azure DevOps"| ADO
  VIEW -->|"opens share link"| SHELL
  SHELL -.->|"sign-in"| ENTRA
  SHELL -->|"iframe"| STATIC
  SHELL -->|"iframe"| DYN
  PLAT -.->|"operates"| aks
```

## Figure 2. What the publisher experiences

*Four steps for a static artifact, five for a Python app. The publisher never leaves Cowork.*

The employee's whole experience is a conversation. Cowork packages the work, uploads it, waits for the verdict, and either hands back a share link with an expiry date, names the people who need to approve, or fixes what the scanner flagged and tries again. Nobody opens a portal, a ticket, or a terminal.

```mermaid
flowchart LR
  A["1. Ask Cowork<br/>publish this internally"] --> B["2. Cowork packages it<br/>manifest and preflight checks"]
  B --> C["3. Upload and scan<br/>about 30 seconds"]
  C -->|"static HTML"| D["4. Live<br/>share link and expiry date"]
  C -->|"Python app"| E["4. Waiting for approval<br/>Cowork names the approver group"]
  E -->|"approved"| D
  C -->|"findings"| F["Rejected<br/>Cowork fixes and resubmits, up to 3 times"]
  F --> C
```

## Figure 3. Behind the scenes: publish and scan

*Two separate channels leave Claude's side: tool calls carry the user's Entra identity, the upload carries a one-time token. Neither carries a password.*

The tool calls originate from Anthropic's connector service with the employee's Entra token, which APIM validates on every call. The upload comes from the Cowork sandbox, which has no identity of its own, so it presents a one-time token minted during the authenticated call. The artifact bytes never pass through the AI model. Malware scanning is done by Microsoft Defender for Storage the moment the upload lands in Blob; the rest of the checks run as a short-lived Kubernetes job per submission.

```mermaid
sequenceDiagram
  autonumber
  actor Pub as Publisher
  participant CW as Cowork agent
  participant SB as Cowork sandbox
  participant AN as Anthropic connector service
  participant GW as App Gateway and APIM
  participant ID as Entra ID
  participant IN as Intake API
  participant SC as Scanner worker
  participant BL as Blob Storage

  Pub->>CW: publish this dashboard internally
  CW->>CW: load publish-to-aks skill, write manifest.json, run preflight.sh
  CW->>AN: tool beginPublish(manifest)
  AN->>GW: POST /v1/publish with Entra bearer token
  GW->>ID: validate token, audience, scope
  ID-->>GW: valid, user oid
  GW->>IN: forward the bearer unchanged
  IN->>IN: verify the token itself (signature, issuer, audience, expiry); identity from claims
  IN-->>CW: jobId, uploadUrl, one-time uploadToken
  Note over AN,GW: replies travel back through APIM and the connector service
  CW->>SB: run upload.sh dist/
  SB->>GW: PUT /v1/publish/{jobId}/upload, bearer uploadToken, zip body
  GW->>IN: stream body, 32 MiB cap
  IN->>BL: write intake/{jobId}.zip
  BL->>BL: Defender for Storage scans the upload on commit
  SB->>GW: POST /v1/publish/{jobId}/finalize with sha256
  GW->>IN: forward
  IN->>SC: queue message on Service Bus
  SC->>BL: read bundle
  SC->>SC: intake checks, gitleaks, HTML and JS rules, Python import allowlist
  SC->>BL: read Defender scan result tag, wait up to 60 s
  SC->>SC: policy.ts verdict
  SC->>BL: write findings and state
  loop every 10 s, up to 10 min
    CW->>AN: tool getPublishStatus(jobId)
    AN->>GW: GET /v1/publish/{jobId}
    GW->>IN: forward
    IN-->>CW: state, and findings or url
  end
  CW-->>Pub: share link and expiry, or findings to fix
```

## Figure 4. Behind the scenes: going live

*Static artifacts go live in seconds by copying files. Python artifacts ride your existing Azure DevOps pipeline: scan, human approval, then cluster admission policy, using the AKS service connection you already have.*

The split is the heart of the design. A static artifact is data served from storage; nothing of it ever executes on the cluster, and nothing calls the Kubernetes API. A Python artifact executes on the cluster, so it goes through Azure DevOps like every other deployment: the pipeline fetches the bundle, runs gitleaks under your policy and Sonar as an advisory report, waits for a member of the approvers group to approve the Environment check, then applies the manifests with the AKS service connection. The cluster's own admission policy still refuses the pod unless its image, security settings and capabilities match what the platform team pinned.

```mermaid
sequenceDiagram
  autonumber
  participant SC as Scanner worker
  participant BL as Blob Storage
  participant ST as Static gateway
  participant ADO as Azure DevOps pipeline
  actor APR as Approver
  participant K8 as Kubernetes API
  participant POL as Azure Policy and Pod Security
  participant POD as Python runtime pod
  participant IN as Intake API

  alt static HTML, seconds
    SC->>BL: copy bundle to serving/{id}/
    ST-->>ST: picks it up from the read-only mount
    SC->>IN: state = live, url = artifacts.corp.com/view/{id}
  else Python app, your normal deployment path
    SC->>ADO: trigger artifact-python-deploy with jobId, Entra token
    ADO->>BL: download bundle via the storage service connection
    ADO->>ADO: gitleaks under policy, Sonar scan attached as advisory report
    ADO->>IN: state = awaiting_approval, run link
    APR->>ADO: approve the Environment check, Entra group artifacts-approvers
    ADO->>K8: helm upgrade --install art-{id} (ConfigMap with app.py, Deployment, Service, HTTPRoute, expiry labels) via the AKS service connection
    K8->>POL: admission review
    POL-->>K8: allowed only if image digest, security context and capabilities match policy
    K8->>POD: schedule on the untrusted node pool
    POD-->>ADO: rollout healthy on port 8080
    ADO->>IN: state = live
  end
```

## Figure 5. What the viewer experiences

*A colleague signs in once on the corporate domain. The artifact itself renders from a separate domain inside a sandboxed frame that the browser will not let navigate away.*

The share link always points at the viewer shell on the corporate domain. The shell does the Entra sign-in, writes an audit entry, and embeds the artifact from the separate artifact domain. From that point the browser enforces the rules: no outbound requests, no forms posting anywhere, no popups, no leaving the frame, no downloads. A persistent banner above the frame reminds viewers never to type credentials into an artifact.

```mermaid
sequenceDiagram
  autonumber
  actor V as Viewer, a colleague
  participant BR as Browser
  participant SH as Viewer shell on artifacts.corp.com
  participant ID as Entra ID
  participant AG as Artifact gateway on id.corp-artifacts.net

  V->>BR: opens artifacts.corp.com/view/{id}
  BR->>SH: GET /view/{id}
  SH->>ID: sign-in with MSAL
  ID-->>SH: viewer identity
  SH->>SH: audit log: viewer, artifact, time
  SH-->>BR: page with sandboxed iframe, frame-src pinned to corp-artifacts.net
  BR->>AG: GET /?t=short-lived token, inside the iframe
  AG->>AG: verify token, set __Host- cookie for this origin only
  AG-->>BR: artifact HTML with strict Content Security Policy
  Note over BR: blocked by the browser from here on: fetch to any host, forms posting anywhere, popups, navigating the frame away, downloads
```

## Figure 6. The life of one publish job

*Every job is in exactly one of nine states. The status tool reports the state and, when relevant, the findings or the approver group.*

This is the view operations will live in. Three exits are terminal: rejected, failed, expired. For Python artifacts, awaiting_approval and deploying are reported by the Azure DevOps pipeline. Nothing lives forever; the TTL in the manifest (default 14 days, maximum 90) is enforced by a nightly garbage-collection pipeline.

```mermaid
stateDiagram-v2
  [*] --> awaiting_upload : beginPublish
  awaiting_upload --> scanning : upload and finalize
  awaiting_upload --> expired : no upload within 10 min
  scanning --> rejected : any deny finding
  scanning --> deploying : static, verdict pass
  scanning --> awaiting_approval : python, verdict pass
  awaiting_approval --> deploying : approved in Azure DevOps
  awaiting_approval --> expired : approval check times out at 7 days
  deploying --> live : route healthy
  deploying --> failed : rollout error
  live --> expired : TTL reached, GC removes it
  rejected --> [*]
  failed --> [*]
  expired --> [*]
```

## Figure 7. If a bad artifact gets through the scanner

*The scanner is a gate, not the wall. Each column lists what an attacker must defeat, outermost first, before anything of value is reachable.*

This is the answer to the question management will ask: what happens when the scan misses something? For static artifacts, the browser's own security model does the containing. For Python artifacts, the cluster does: no network, no identity, no storage, a node pool shared with nothing else, and a human who said yes.

```mermaid
flowchart TB
  subgraph s ["Static artifact: runs in the viewer's browser"]
    direction TB
    S1["Separate domain corp-artifacts.net<br/>no corporate cookies, no same-site access"] --> S2["One origin per artifact<br/>cannot touch another artifact's data"]
    S2 --> S3["Sandboxed iframe in the shell<br/>no popups, no top navigation, frame-src pinned"]
    S3 --> S4["Content Security Policy<br/>no fetch, XHR or WebSocket to any host"]
    S4 --> S5["Scanner rules<br/>no password fields, no external forms or scripts"]
  end
  subgraph d ["Python artifact: runs on the cluster"]
    direction TB
    D1["Human approval<br/>Azure DevOps Environment check, Entra approvers group"] --> D2["Dedicated tainted node pool<br/>nothing else is scheduled there"]
    D2 --> D3["NetworkPolicy deny-all egress<br/>no DNS, no internet, no IMDS, no cluster services"]
    D3 --> D4["No service-account token, no cloud identity<br/>app.py mounted read-only from a ConfigMap"]
    D4 --> D5["Restricted Pod Security and Azure Policy<br/>non-root, read-only root, no capabilities, pinned image"]
    D5 --> D6["Outside the mesh<br/>mesh workloads refuse plaintext callers"]
    D6 --> D7["Scanner rules<br/>import allowlist, no subprocess or sockets"]
  end
```

## Who does what

| Role | Who | Does | How often |
|---|---|---|---|
| Publisher | Any employee with Cowork and the connector | Asks Cowork to publish. Fixes findings when asked. Receives the link and expiry. | Whenever they have something to share |
| Approver | Members of the Entra group artifacts-approvers | Opens the Azure DevOps run, reads the scan summary and Sonar report, approves or rejects the Environment check. | Per Python artifact, within 7 days |
| Viewer | Anyone in the tenant who gets the link | Opens the shell link, signs in, views the artifact. | Any time until the TTL |
| Platform team | Owners of the pipeline repo | Maintains the skill, the connector, the scanner image, the curated Python runtime, Azure Policy, the two Azure DevOps pipelines and the Environment check. Reviews pull requests to policy files. | Runtime image on request; policy by PR |
| Claude org Owner | Claude Team or Enterprise owner | Adds the custom connector once. Publishes the skill to the skills repo. | Once, then on changes |
| Azure identity admin | Entra administrator | Owns the two app registrations and the approvers group membership. | Setup, then membership changes |
